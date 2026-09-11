'use strict';

const config = require('../../config/config');
const { seedDefaultSettings } = require('../../modules/admin/setting.model');

// Avoid implicit writes while inspecting a production-like database locally.
const startDefaultSettingsSeed = ({
    safeLocalProductionMode = config.safeLocalProductionMode,
    seed = seedDefaultSettings,
} = {}) => {
    if (safeLocalProductionMode) return false;
    Promise.resolve(seed()).catch(() => {});
    return true;
};

module.exports = { startDefaultSettingsSeed };
