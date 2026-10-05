'use strict';

jest.mock('../modules/auth/googleIdToken.service', () => ({
    verifyGoogleIdToken: jest.fn(),
}));
jest.mock('../modules/auth/googleOAuth.service', () => ({
    resolveGoogleUser: jest.fn(),
}));

const { verifyGoogleIdToken } = require('../modules/auth/googleIdToken.service');
const { resolveGoogleUser } = require('../modules/auth/googleOAuth.service');
const { loginWithNativeGoogle } = require('../modules/auth/auth.service');
const { USER_STATUS } = require('../modules/users/user.model');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createCustomerWithGroup,
} = require('./testHelpers');

beforeAll(async () => {
    await connectTestDB();
});

afterAll(async () => {
    await disconnectTestDB();
});

beforeEach(async () => {
    await clearCollections();
    jest.resetAllMocks();
    verifyGoogleIdToken.mockResolvedValue({
        sub: 'google-subject',
        email: 'identity@example.com',
        name: 'Verified Identity',
        email_verified: true,
    });
});

describe('native Google ID-token exchange', () => {
    it('uses only the verified identity and issues the standard EL-JASSER session', async () => {
        const { customer } = await createCustomerWithGroup({
            googleId: 'google-subject',
            email: 'identity@example.com',
            profileCompletedAt: new Date(),
            phone: '+201000000000',
            country: 'EG',
            currency: 'USD',
        });
        resolveGoogleUser.mockResolvedValue({ user: customer });

        const result = await loginWithNativeGoogle({
            idToken: 'opaque-google-token',
            intent: 'login',
            referralCode: 'IGNORED_FOR_LOGIN',
            email: 'attacker@example.com',
            role: 'ADMIN',
        });

        expect(result.token).toEqual(expect.any(String));
        expect(result.user.email).toBe('identity@example.com');
        expect(resolveGoogleUser).toHaveBeenCalledWith(expect.objectContaining({
            id: 'google-subject',
            emails: [{ value: 'identity@example.com' }],
        }), { intent: 'login', referralCode: 'IGNORED_FOR_LOGIN' });
    });

    it('preserves rejected-account blocking after a verified native identity', async () => {
        const { customer } = await createCustomerWithGroup({
            googleId: 'google-subject',
            status: USER_STATUS.REJECTED,
        });
        resolveGoogleUser.mockResolvedValue({ user: customer });

        await expect(loginWithNativeGoogle({ idToken: 'opaque-google-token' }))
            .rejects.toMatchObject({ code: 'AUTHENTICATION_ERROR' });
    });

    it('preserves pending-account handling and does not issue a session', async () => {
        const { customer } = await createCustomerWithGroup({
            googleId: 'google-subject',
            status: USER_STATUS.PENDING,
        });
        resolveGoogleUser.mockResolvedValue({ user: customer });

        const result = await loginWithNativeGoogle({ idToken: 'opaque-google-token' });

        expect(result.token).toBeNull();
        expect(result.message).toMatch(/awaiting admin approval/i);
    });

    it('requires the same phone-completion flow for an incomplete Google account', async () => {
        const { customer } = await createCustomerWithGroup({
            googleId: 'google-subject',
            country: 'EG',
            currency: 'USD',
            phone: '',
            profileCompletedAt: new Date(),
        });
        resolveGoogleUser.mockResolvedValue({ user: customer });

        const result = await loginWithNativeGoogle({ idToken: 'opaque-google-token' });

        expect(result.status).toBe('PROFILE_COMPLETION_REQUIRED');
        expect(result.completionToken).toEqual(expect.any(String));
        expect(result.missingProfileFields).toEqual(['phone']);
        expect(result.token).toBeUndefined();
    });

    it('passes signup referral intent to the shared Google user resolver', async () => {
        const { customer } = await createCustomerWithGroup({
            googleId: 'google-subject',
            country: 'EG',
            currency: 'USD',
            phone: '+201000000000',
        });
        resolveGoogleUser.mockResolvedValue({ user: customer });

        await loginWithNativeGoogle({
            idToken: 'opaque-google-token',
            intent: 'signup',
            referralCode: 'REFERRAL123',
        });

        expect(resolveGoogleUser).toHaveBeenCalledWith(expect.any(Object), {
            intent: 'signup',
            referralCode: 'REFERRAL123',
        });
    });
});
