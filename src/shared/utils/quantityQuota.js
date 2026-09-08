'use strict';

const toNonNegativeNumber = (value) => Math.max(0, Number(value) || 0);

const buildQuantityQuota = (user) => {
    const quantityLimit = toNonNegativeNumber(user?.quantityLimit);
    const quantityUsed = toNonNegativeNumber(user?.quantityUsed);
    const quantityRemaining = Math.max(0, quantityLimit - quantityUsed);
    const group = user?.groupId || user?.group || null;
    const billingMode = group?.billingMode || user?.billingMode || 'standard';

    return {
        billingMode,
        isQuantityOnly: billingMode === 'quantity_only',
        quantityLimit,
        quantityUsed,
        quantityRemaining,
    };
};

module.exports = { buildQuantityQuota };
