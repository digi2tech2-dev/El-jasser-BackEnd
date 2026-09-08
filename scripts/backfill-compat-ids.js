'use strict';

const path = require('path');
const mongoose = require('mongoose');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const connectDB = require('../src/config/database');
const { Product } = require('../src/modules/products/product.model');
const { Category } = require('../src/modules/categories/category.model');
const { Counter, getNextSequence } = require('../src/modules/orders/counter.model');

const missingFieldFilter = (field) => ({
    $or: [
        { [field]: { $exists: false } },
        { [field]: null },
    ],
});

const syncCounterToExistingMax = async ({ Model, field, counterName, startAt }) => {
    const maxDoc = await Model.findOne({ [field]: { $type: 'number' } })
        .select(field)
        .sort({ [field]: -1 })
        .lean();

    const maxExisting = Number(maxDoc?.[field]);
    const targetSeq = Number.isFinite(maxExisting) ? Math.max(startAt, maxExisting) : startAt;

    await Counter.updateOne(
        { _id: counterName },
        { $max: { seq: targetSeq } },
        { upsert: true }
    );
};

const assignMissingIds = async ({ Model, field, counterName, startAt, label }) => {
    await syncCounterToExistingMax({ Model, field, counterName, startAt });

    let scanned = 0;
    let assigned = 0;
    const filter = missingFieldFilter(field);
    const cursor = Model.find(filter)
        .select('_id')
        .sort({ createdAt: 1, _id: 1 })
        .lean()
        .cursor();

    for await (const doc of cursor) {
        scanned += 1;

        for (let attempt = 1; attempt <= 5; attempt += 1) {
            const nextValue = await getNextSequence(counterName, startAt);

            try {
                const result = await Model.updateOne(
                    { _id: doc._id, ...filter },
                    { $set: { [field]: nextValue } }
                );

                if (result.modifiedCount > 0) assigned += 1;
                break;
            } catch (err) {
                if (err.code === 11000 && attempt < 5) continue;
                throw err;
            }
        }
    }

    console.log(`${label}: scanned ${scanned}, assigned ${assigned}`);
};

const main = async () => {
    if (!process.env.MONGO_URI) {
        throw new Error('MONGO_URI is required.');
    }

    await connectDB();

    await assignMissingIds({
        Model: Category,
        field: 'compatCategoryId',
        counterName: 'compatCategoryId',
        startAt: 1,
        label: 'Categories',
    });

    await assignMissingIds({
        Model: Product,
        field: 'compatProductId',
        counterName: 'compatProductId',
        startAt: 999,
        label: 'Products',
    });
};

main()
    .then(async () => {
        await mongoose.disconnect();
        console.log('Compatibility ID backfill complete.');
        process.exit(0);
    })
    .catch(async (err) => {
        console.error(err);
        await mongoose.disconnect().catch(() => {});
        process.exit(1);
    });
