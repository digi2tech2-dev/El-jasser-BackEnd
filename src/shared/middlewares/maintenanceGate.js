'use strict';

const jwt = require('jsonwebtoken');
const config = require('../../config/config');
const { User, USER_STATUS, ROLES } = require('../../modules/users/user.model');
const maintenanceService = require('../../modules/maintenance/maintenance.service');

const isAuthorizedAdmin = async (req) => {
    const authorization = req.headers.authorization || '';
    if (!authorization.startsWith('Bearer ')) return false;

    try {
        const token = authorization.slice(7).trim();
        const decoded = jwt.verify(token, config.jwt.secret);
        if (!decoded?.id || decoded.purpose === '2fa-pending') return false;
        const user = await User.findById(decoded.id).select('role status profileCompletionRequired').lean();
        return user?.role === ROLES.ADMIN && user?.status === USER_STATUS.ACTIVE && !user?.profileCompletionRequired;
    } catch {
        return false;
    }
};

const isMaintenanceControlRequest = (req) => {
    const requestPath = String(req.originalUrl || '').split('?')[0];
    return requestPath === '/api/maintenance/status';
};

const isCompatRequest = (req) => {
    const requestPath = String(req.originalUrl || '').split('?')[0];
    return requestPath === '/client/api' || requestPath.startsWith('/client/api/') || requestPath === '/api/client/api' || requestPath.startsWith('/api/client/api/');
};

const maintenanceGate = async (req, res, next) => {
    try {
        const { enabled } = await maintenanceService.getStatus();
        const paymentCallback = req.method === 'POST' && req.path === '/payment-events/vodafone-cash';
        const isAuthRequest = req.path === '/auth' || req.path.startsWith('/auth/');
        if (!enabled || isMaintenanceControlRequest(req) || isAuthRequest || paymentCallback) return next();
        if (await isAuthorizedAdmin(req)) return next();

        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');
        if (isCompatRequest(req)) {
            return res.status(503).json({ status: 'ERROR', code: 130, message: 'Site is under maintenance' });
        }
        return res.status(503).json({
            success: false,
            code: 'MAINTENANCE_MODE',
            message: 'The store is temporarily unavailable while maintenance is in progress.',
        });
    } catch (error) {
        return next(error);
    }
};

module.exports = maintenanceGate;
module.exports.isAuthorizedAdmin = isAuthorizedAdmin;
