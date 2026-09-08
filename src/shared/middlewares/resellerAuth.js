'use strict';

const { User, USER_STATUS } = require('../../modules/users/user.model');

const normalizeIp = (value) => String(value || '')
    .split(',')[0]
    .trim()
    .replace(/^::ffff:/, '');

const COMPAT_AUTH_ERROR_CODES = {
    RESELLER_TOKEN_REQUIRED: 120,
    RESELLER_TOKEN_INVALID: 121,
    RESELLER_NOT_ALLOWED: 122,
    RESELLER_IP_FORBIDDEN: 123,
    RESELLER_AUTH_FAILED: 121,
};

const COMPAT_AUTH_ERROR_MESSAGES = {
    RESELLER_TOKEN_REQUIRED: 'API Token is required',
    RESELLER_TOKEN_INVALID: 'Token error',
    RESELLER_NOT_ALLOWED: 'Not allowed to use API',
    RESELLER_IP_FORBIDDEN: 'IP not allowed',
    RESELLER_AUTH_FAILED: 'Token error',
};

const sendAuthError = (req, res, statusCode, message, code) => {
    if (req.clientCompatErrorFormat) {
        return res.status(statusCode).json({
            status: 'ERROR',
            code: COMPAT_AUTH_ERROR_CODES[code] || 121,
            message: COMPAT_AUTH_ERROR_MESSAGES[code] || message,
        });
    }

    return res.status(statusCode).json({
        success: false,
        message,
        code,
    });
};

const extractApiToken = (req) => {
    const headerToken = req.get('x-api-key') || req.get('api-token');
    if (headerToken) return String(headerToken).trim();

    const authorization = req.get('authorization') || '';
    if (authorization.toLowerCase().startsWith('bearer ')) {
        return authorization.slice(7).trim();
    }

    return '';
};

const resellerAuth = async (req, res, next) => {
    try {
        const token = extractApiToken(req);
        if (!token) {
            return sendAuthError(req, res, 401, 'Missing API token.', 'RESELLER_TOKEN_REQUIRED');
        }

        const candidateFilter = req.clientCompatErrorFormat
            ? {
                apiToken: { $exists: true, $ne: null },
                deletedAt: null,
            }
            : {
                isApiEnabled: true,
                status: USER_STATUS.ACTIVE,
                apiToken: { $exists: true, $ne: null },
                deletedAt: null,
            };

        const candidates = await User.find(candidateFilter)
            .select('+apiToken +apiSecret name email role status walletBalance creditLimit creditUsed currency groupId isApiEnabled whitelistIps webhookUrl')
            .populate('groupId', 'name percentage isActive billingMode');

        let reseller = null;
        for (const candidate of candidates) {
            if (await candidate.compareApiToken(token)) {
                reseller = candidate;
                break;
            }
        }

        if (!reseller) {
            return sendAuthError(req, res, 401, 'Invalid API token.', 'RESELLER_TOKEN_INVALID');
        }

        if (reseller.status !== USER_STATUS.ACTIVE || reseller.isApiEnabled !== true) {
            return sendAuthError(req, res, 403, 'Not allowed to use API.', 'RESELLER_NOT_ALLOWED');
        }

        const whitelist = (Array.isArray(reseller.whitelistIps) ? reseller.whitelistIps : [])
            .map(normalizeIp)
            .filter(Boolean);
        const requestIp = normalizeIp(req.ip || req.socket?.remoteAddress || req.get('x-forwarded-for'));

        if (whitelist.length > 0 && !whitelist.includes(requestIp)) {
            return sendAuthError(req, res, 403, 'Request IP is not whitelisted.', 'RESELLER_IP_FORBIDDEN');
        }

        req.reseller = reseller;
        req.user = reseller;
        req.auditContext = {
            actorId: reseller._id,
            actorRole: 'RESELLER',
            ipAddress: requestIp || null,
            userAgent: req.get('User-Agent') || null,
        };

        return next();
    } catch (err) {
        return sendAuthError(req, res, 401, err.message || 'API authentication failed.', 'RESELLER_AUTH_FAILED');
    }
};

module.exports = resellerAuth;
