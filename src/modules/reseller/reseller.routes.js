'use strict';

const express = require('express');
const { body, param } = require('express-validator');
const resellerAuth = require('../../shared/middlewares/resellerAuth');
const validate = require('../../shared/middlewares/validate');
const resellerController = require('./reseller.controller');

const router = express.Router();

router.use(resellerAuth);

router.get('/balance', resellerController.getBalance);
router.get('/products', resellerController.listProducts);

router.post(
    '/orders',
    [
        body('productId').notEmpty().withMessage('productId is required').isMongoId().withMessage('Invalid productId'),
        body('quantity').notEmpty().withMessage('quantity is required').isInt({ min: 1 }).withMessage('quantity must be a positive integer'),
        body('idempotencyKey').optional().isString().trim().isLength({ min: 8, max: 120 }).withMessage('idempotencyKey must be 8-120 characters'),
        body('playerId').optional({ nullable: true }).isString().trim().isLength({ max: 120 }).withMessage('playerId cannot exceed 120 characters'),
        body('orderFieldsValues').optional({ nullable: true }).isObject().withMessage('orderFieldsValues must be an object'),
        body('dynamicFields').optional({ nullable: true }).isObject().withMessage('dynamicFields must be an object'),
        body('customInputs').optional({ nullable: true }).isObject().withMessage('customInputs must be an object'),
    ],
    validate,
    resellerController.createOrder
);

router.get(
    '/orders/:idempotencyKey',
    [
        param('idempotencyKey').isString().trim().isLength({ min: 1, max: 120 }).withMessage('Invalid idempotencyKey'),
    ],
    validate,
    resellerController.getOrderByIdempotencyKey
);

module.exports = router;
