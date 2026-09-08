'use strict';

const path = require('path');
const mongoose = require('mongoose');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const connectDB = require('../src/config/database');
const { User } = require('../src/modules/users/user.model');
const { recalculateCreditUsed } = require('../src/modules/wallet/wallet.service');

const shouldWrite = process.argv.includes('--write');

const main = async () => {
    if (!process.env.MONGO_URI) {
        throw new Error('MONGO_URI is required.');
    }

    await connectDB();

    let scanned = 0;
    let changed = 0;

    const cursor = User.find({ deletedAt: null })
        .select('_id walletBalance creditLimit creditUsed')
        .sort({ _id: 1 })
        .cursor();

    for await (const user of cursor) {
        scanned += 1;

        const expected = recalculateCreditUsed(user.walletBalance, user.creditLimit);
        const current = Number(user.creditUsed || 0);
        if (Math.abs(current - expected) < 0.01) continue;

        changed += 1;

        if (shouldWrite) {
            await User.updateOne(
                { _id: user._id },
                { $set: { creditUsed: expected } }
            );
        }
    }

    console.log(`Users scanned: ${scanned}`);
    console.log(`Users ${shouldWrite ? 'updated' : 'needing update'}: ${changed}`);
    if (!shouldWrite) {
        console.log('Dry run only. Re-run with --write to apply changes.');
    }
};

main()
    .then(async () => {
        await mongoose.disconnect();
        process.exit(0);
    })
    .catch(async (err) => {
        console.error(err);
        await mongoose.disconnect().catch(() => {});
        process.exit(1);
    });
