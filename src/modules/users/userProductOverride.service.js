'use strict';

const { UserProductOverride } = require('./userProductOverride.model');

const getUserProductOverride = async (userId, productId, session = null) => {
    let query = UserProductOverride.findOne({ userId, productId }).lean();
    if (session) query = query.session(session);
    return query;
};

const getUserProductOverrides = async (userId, productIds = []) => {
    const filter = { userId };
    if (Array.isArray(productIds) && productIds.length > 0) filter.productId = { $in: productIds };
    const rows = await UserProductOverride.find(filter).lean();
    return new Map(rows.map((row) => [String(row.productId), row]));
};

module.exports = { getUserProductOverride, getUserProductOverrides };
