'use strict';

const http = require('http');
const { User, ROLES, USER_STATUS } = require('../modules/users/user.model');
const { register, login, loginWithGoogle, completeGoogleProfile } = require('../modules/auth/auth.service');
const userService = require('../modules/users/user.service');
const referralDashboardService = require('../modules/referrals/referralDashboard.service');
const { assertCompleteProfile } = require('../shared/middlewares/requireCompleteProfile');
const { normalizePhone } = require('../shared/utils/phone');
const { Currency } = require('../modules/currency/currency.model');
const { registerValidation } = require('../modules/auth/auth.validation');
const { validationResult } = require('express-validator');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createCustomer,
    createGroup,
} = require('./testHelpers');

let app;
let server;
let baseUrl;

const apiRequest = (method, path, { token, body } = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const url = new URL(path, baseUrl);
    const req = http.request(url, {
        method,
        headers: {
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
    }, (res) => {
        let responseBody = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { responseBody += chunk; });
        res.on('end', () => {
            try {
                resolve({ status: res.statusCode, body: responseBody ? JSON.parse(responseBody) : null });
            } catch (err) {
                reject(err);
            }
        });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
});

const createLegacyAuthenticatedCustomer = async () => {
    const group = await createGroup();
    const user = await createCustomer({
        groupId: group._id,
        email: `legacy-route-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
        password: 'ValidPass@1',
        phone: undefined,
    });
    const session = await login({ email: user.email, password: 'ValidPass@1' });
    return { user, token: session.token };
};

beforeAll(async () => {
    await connectTestDB();
    app = require('../app');
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await disconnectTestDB();
});
beforeEach(clearCollections);

const seedCurrency = () => Currency.create({
    code: 'USD', name: 'US Dollar', symbol: '$', platformRate: 1, isActive: true,
});

describe('phone normalization', () => {
    const validationErrorsFor = async (phone) => {
        const req = {
            body: {
                name: 'Validation User', email: 'validation@example.com', password: 'ValidPass@1', phone,
            },
        };
        await Promise.all(registerValidation.map((validator) => validator.run(req)));
        return validationResult(req).array();
    };

    it('requires a phone in the public registration request and rejects invalid input before user creation', async () => {
        expect(await validationErrorsFor(undefined)).toEqual(expect.arrayContaining([
            expect.objectContaining({ path: 'phone' }),
        ]));
        expect(await validationErrorsFor('not a phone')).toEqual(expect.arrayContaining([
            expect.objectContaining({ path: 'phone' }),
        ]));
    });

    it('normalizes Arabic/Persian digits and display separators without guessing country code', () => {
        expect(normalizePhone('٠١٠١٢٣٤٥٦٧٨')).toBe('01012345678');
        expect(normalizePhone('+20 (101) 234-5678')).toBe('+201012345678');
        expect(normalizePhone('۰۱۰۱۲۳۴۵۶۷۸')).toBe('01012345678');
    });

    it('rejects alphabetic values, malformed plus signs, and invalid lengths', () => {
        expect(() => normalizePhone('010-ABC-5678')).toThrow();
        expect(() => normalizePhone('01+01234567')).toThrow();
        expect(() => normalizePhone('123456')).toThrow();
    });
});

describe('customer phone compatibility and completion', () => {
    it('allows an incomplete customer through GET/PATCH /api/users/me but gates default protected routes and still requires JWT authentication', async () => {
        const { user, token } = await createLegacyAuthenticatedCustomer();

        const profile = await apiRequest('GET', '/api/users/me', { token });
        expect(profile.status).toBe(200);
        expect(profile.body.data.profileCompletionRequired).toBe(true);

        const protectedRoute = await apiRequest('GET', '/api/users', { token });
        expect(protectedRoute.status).toBe(403);
        expect(protectedRoute.body.code).toBe('PROFILE_COMPLETION_REQUIRED');

        const completion = await apiRequest('PATCH', '/api/users/me', {
            token,
            body: { phone: '+20 (101) 234-5678' },
        });
        expect(completion.status).toBe(200);
        expect(completion.body.data.phone).toBe('+201012345678');
        expect(completion.body.data.profileCompletionRequired).toBe(false);

        const fresh = await User.findById(user._id);
        expect(fresh.phone).toBe('+201012345678');

        const missingToken = await apiRequest('GET', '/api/users/me');
        expect(missingToken.status).toBe(401);

        const invalidToken = await apiRequest('GET', '/api/users/me', { token: 'invalid-jwt' });
        expect(invalidToken.status).toBe(401);
    });

    it('keeps a legacy customer valid, permits login, then completes only phone without touching financial or role data', async () => {
        const group = await createGroup();
        const legacy = await createCustomer({
            groupId: group._id,
            email: `legacy-${Date.now()}@example.com`,
            password: 'ValidPass@1',
            phone: undefined,
            walletBalance: 37,
            creditLimit: 10,
            creditUsed: 4,
        });

        expect(legacy.phone).toBeNull();
        expect(legacy.profileCompletionRequired).toBe(true);
        const loggedIn = await login({ email: legacy.email, password: 'ValidPass@1' });
        expect(loggedIn.token).toBeTruthy();
        expect(loggedIn.user.profileCompletionRequired).toBe(true);

        const completed = await userService.updateMyProfile(legacy._id, { phone: '٠١٠١٢٣٤٥٦٧٨' });
        expect(completed.phone).toBe('01012345678');
        expect(completed.profileCompletionRequired).toBe(false);

        const fresh = await User.findById(legacy._id);
        expect(fresh.role).toBe(ROLES.CUSTOMER);
        expect(fresh.walletBalance).toBe(37);
        expect(fresh.creditLimit).toBe(10);
        expect(fresh.creditUsed).toBe(4);
    });

    it('does not let a completed customer clear its required phone', async () => {
        const group = await createGroup();
        const customer = await createCustomer({ groupId: group._id, phone: '01012345678' });
        await expect(userService.updateMyProfile(customer._id, { phone: '' }))
            .rejects.toMatchObject({ code: 'PHONE_REQUIRED' });
    });

    it('does not gate staff accounts merely because phone is absent', async () => {
        const group = await createGroup();
        const staff = await User.create({
            name: 'Legacy Admin', email: `admin-${Date.now()}@example.com`, password: 'ValidPass@1',
            role: ROLES.ADMIN, groupId: group._id, status: USER_STATUS.ACTIVE, verified: true,
        });
        expect(staff.profileCompletionRequired).toBe(false);
        expect(() => assertCompleteProfile(staff)).not.toThrow();
    });
});

describe('new registration and Google completion', () => {
    it('stores normalized phone for new local users and accepts duplicate valid numbers', async () => {
        await seedCurrency();
        await createGroup();
        const first = await register({
            name: 'First User', email: `first-${Date.now()}@example.com`, password: 'ValidPass@1',
            country: 'EG', currency: 'USD', phone: '+20 (101) 234-5678',
        });
        const second = await register({
            name: 'Second User', email: `second-${Date.now()}@example.com`, password: 'ValidPass@1',
            country: 'EG', currency: 'USD', phone: '+20 101 234 5678',
        });
        expect(first.user.phone).toBe('+201012345678');
        expect(second.user.phone).toBe('+201012345678');
    });

    it('returns old Google users with completed country/currency to phone-only completion and preserves those values', async () => {
        const group = await createGroup();
        const user = await User.create({
            name: 'Legacy Google', email: `google-${Date.now()}@example.com`, googleId: `google-${Date.now()}`,
            role: ROLES.CUSTOMER, groupId: group._id, status: USER_STATUS.ACTIVE, verified: true,
            country: 'EG', currency: 'USD', profileCompletedAt: new Date(),
        });

        const loginResult = await loginWithGoogle(user);
        expect(loginResult.status).toBe('PROFILE_COMPLETION_REQUIRED');
        expect(loginResult.missingProfileFields).toEqual(['phone']);

        const completed = await completeGoogleProfile({
            completionToken: loginResult.completionToken,
            phone: '01012345678',
        });
        expect(completed.user.phone).toBe('01012345678');
        expect(completed.user.country).toBe('EG');
        expect(completed.user.currency).toBe('USD');
    });
});

describe('referral dashboard privacy', () => {
    it('does not serialize an invited customer phone to the referrer', async () => {
        const group = await createGroup();
        const referrer = await createCustomer({ groupId: group._id, phone: '01012345678' });
        const invited = await createCustomer({
            groupId: group._id, phone: '01112345678', referredBy: referrer._id, referredAt: new Date(),
        });
        const dashboard = await referralDashboardService.getCustomerReferralDashboard(referrer._id);
        expect(dashboard.invitedUsers.find((entry) => entry.id === invited._id.toString()).phone).toBeUndefined();
    });
});
