'use strict';

const { Router } = require('express');
const controller = require('./paymentEvent.controller');

const router = Router();

// Device authentication is performed by the controller against the raw body;
// this public machine-to-machine route intentionally has no customer JWT.
router.post('/vodafone-cash', controller.receiveVodafoneCashEvent);

module.exports = router;
