'use strict';

const { AppError } = require('../errors/AppError');

// Keep this middleware independent of the User model so authentication can load
// it without introducing a model/middleware dependency cycle.
const CUSTOMER_ROLE = 'CUSTOMER';

const assertCompleteProfile = (user) => {
    if (user?.role === CUSTOMER_ROLE && user.profileCompletionRequired) {
        throw new AppError(
            'Profile completion is required before accessing the platform.',
            403,
            'PROFILE_COMPLETION_REQUIRED'
        );
    }
};

const requireCompleteProfile = (req, _res, next) => {
    assertCompleteProfile(req.user);
    next();
};

module.exports = {
    assertCompleteProfile,
    requireCompleteProfile,
};
