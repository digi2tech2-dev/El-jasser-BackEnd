'use strict';

const express = require('express');

const resellerAuth = require('../../shared/middlewares/resellerAuth');
const controller = require('./clientCompat.controller');
const { catchCompat } = require('./clientCompat.errors');

const router = express.Router();

const markCompatErrorFormat = (req, res, next) => {
    req.clientCompatErrorFormat = true;
    next();
};

router.use(markCompatErrorFormat, resellerAuth);

router.get('/profile', catchCompat(controller.getProfile));
router.get('/products', catchCompat(controller.listProducts));
router.get('/content/:parentId', catchCompat(controller.getContent));
router.get('/newOrder/:productId/params', catchCompat(controller.placeOrder));
router.get('/check', catchCompat(controller.checkOrders));

module.exports = router;
