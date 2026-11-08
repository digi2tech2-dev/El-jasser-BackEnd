'use strict';

const { Router } = require('express');
const rateLimit = require('express-rate-limit');
const authenticate = require('../../shared/middlewares/authenticate');
const authorize = require('../../shared/middlewares/authorize');
const catchAsync = require('../../shared/utils/catchAsync');
const { sendSuccess } = require('../../shared/utils/apiResponse');
const { createUpload, validateUploadedFileSignature } = require('../../shared/middlewares/upload');
const { AppError, BusinessRuleError } = require('../../shared/errors/AppError');
const fs = require('fs/promises');
const sharp = require('sharp');
const service = require('./theme.service');
const { Setting } = require('../admin/setting.model');

const router = Router();
router.use(authenticate, authorize('ADMIN'));
const publishLimit = rateLimit({ windowMs: 60 * 60 * 1000, limit: 60, standardHeaders: 'draft-8',
    legacyHeaders: false, message: { success: false, code: 'THEME_RATE_LIMIT', message: 'Too many theme publishes.' } });
const mediaLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20 });
const paidFeatureDisabled = (_req, _res, next) => next(new AppError(
    'All platform theme features are free. No payment or activation code is required.', 410, 'THEME_SUBSCRIPTIONS_FREE'));

router.get('/settings', catchAsync(async (_req, res) => sendSuccess(res, await service.settings())));
router.get('/notification-whatsapp', catchAsync(async (_req, res) => {
    const setting = await Setting.findOne({ key: 'adminNotificationWhatsApp' }).select('value').lean();
    return sendSuccess(res, { value: setting?.value || process.env.ADMIN_NOTIFICATION_NUMBER || '' });
}));
router.get('/presets', (_req, res) => sendSuccess(res, { presets: service.presets(), allowed: service.allowed }));
router.post('/preview/validate', catchAsync(async (req, res) => sendSuccess(res,
    { configuration: service.validateTheme(req.body) }, 'Theme is valid')));
router.post('/draft', catchAsync(async (req, res) => sendSuccess(res,
    await service.saveDraft(req.user._id, req.body), 'Draft saved')));
router.post('/draft/reset', catchAsync(async (_req, res) => sendSuccess(res,
    await service.resetDraft(), 'Draft reset')));
router.post('/publish', publishLimit, catchAsync(async (req, res) => sendSuccess(res,
    await service.publish(req.user._id, req.body), 'Theme published')));
router.post('/restore', publishLimit, catchAsync(async (req, res) => sendSuccess(res,
    await service.restore(req.user._id, req.body?.version), 'Theme restored')));
router.post('/restore-draft', catchAsync(async (req, res) => sendSuccess(res,
    await service.restoreToDraft(Number(req.body?.version)), 'Theme version loaded as draft')));
router.get('/history', catchAsync(async (req, res) => sendSuccess(res,
    await service.history(Number(req.query.page || 1)))));
router.get('/entitlement', catchAsync(async (_req, res) => {
    const state = await service.getStatus();
    return sendSuccess(res, { eligibility: state.eligibility, plan: service.plan, checkoutAvailable: false, allFeaturesFree: true });
}));
router.get('/subscription', catchAsync(async (_req, res) => {
    const state = await service.getStatus();
    return sendSuccess(res, { eligibility: state.eligibility, plan: service.plan, plans: service.plans,
        checkoutAvailable: false, allFeaturesFree: true, manualPayment: { available: false } });
}));
router.get('/subscription/payment-status', (_req, res) => sendSuccess(res, { items: [], allFeaturesFree: true }));
router.post('/subscription/manual-order', paidFeatureDisabled);
router.get('/subscription/review-queue', (_req, res) => sendSuccess(res, { items: [], allFeaturesFree: true }));
router.post('/subscription/manual-order/confirm', paidFeatureDisabled);
router.post('/subscription/manual-order/reissue-code', paidFeatureDisabled);
router.post('/subscription/redeem', paidFeatureDisabled);
router.post('/subscription/checkout', paidFeatureDisabled);
router.post('/media/upload', mediaLimit, (req, res, next) => {
    createUpload('themes').single('image')(req, res, async (error) => {
        if (error) return next(error);
        if (!req.file) return next(new BusinessRuleError('An image is required.', 'MISSING_FILE'));
        try {
            await validateUploadedFileSignature(req.file);
            const metadata = await sharp(req.file.path).metadata();
            if (req.file.size > 5 * 1024 * 1024 || !metadata.width || !metadata.height
                || metadata.width < 128 || metadata.height < 128
                || metadata.width > 6000 || metadata.height > 6000) {
                throw new BusinessRuleError('Image must be 128–6000 pixels and at most 5 MB.', 'INVALID_THEME_IMAGE');
            }
            return sendSuccess(res, { path: `/uploads/themes/${req.file.filename}` }, 'Theme image uploaded');
        } catch (validationError) {
            await fs.unlink(req.file.path).catch(() => undefined);
            return next(validationError);
        }
    });
});

module.exports = router;
