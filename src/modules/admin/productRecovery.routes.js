'use strict';
const router = require('express').Router();
const authenticate = require('../../shared/middlewares/authenticate');
const authorize = require('../../shared/middlewares/authorize');
const requirePermission = require('../../shared/middlewares/requirePermission');
const catchAsync = require('../../shared/utils/catchAsync');
const { sendSuccess } = require('../../shared/utils/apiResponse');
const recovery = require('./productRecovery.service');
const { Provider } = require('../providers/provider.model');
router.use(authenticate, authorize('ADMIN', 'SUPERVISOR'), requirePermission('MANAGE_PRODUCTS'));
router.get('/providers', catchAsync(async (_req, res) => sendSuccess(res, { providers: await Provider.find({ isActive: true, deletedAt: null }).select('_id name').sort({ name: 1 }).lean() })));
router.get('/search', catchAsync(async (req, res) => sendSuccess(res, await recovery.search({
    search: req.query.search, providerId: req.query.providerId, sort: req.query.sort,
    availability: req.query.availability, minPrice: req.query.minPrice, maxPrice: req.query.maxPrice,
    page: Number(req.query.page || 1), limit: Number(req.query.limit || 30),
    refresh: req.query.refresh === 'true',
}))));
router.post('/publish', catchAsync(async (req, res) => sendSuccess(res, await recovery.publish(req.body.products, req.user._id))));
module.exports = router;
