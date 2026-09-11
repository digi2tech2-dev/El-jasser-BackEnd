'use strict';

const { Setting } = require('../admin/setting.model');
const { ERROR_CODES } = require('./clientCompat.errors');

// Maintenance deliberately blocks only compatibility order creation. Catalogue
// and status calls stay available to existing integrations.
const requireCompatOrderingAvailable = async (_req, res, next) => {
    try {
        const maintenance = await Setting.findOne({ key: 'maintenanceMode' })
            .select('value')
            .lean();

        if (maintenance?.value === true) {
            return res.status(503).json({
                status: 'ERROR',
                code: ERROR_CODES.MAINTENANCE,
                message: 'Site is under maintenance',
            });
        }

        return next();
    } catch (_err) {
        return res.status(500).json({
            status: 'ERROR',
            code: ERROR_CODES.INTERNAL,
            message: 'Unknown internal error',
        });
    }
};

module.exports = { requireCompatOrderingAvailable };
