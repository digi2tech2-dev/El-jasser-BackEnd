'use strict';

/**
 * upload.routes.js — Generic image upload endpoint.
 *
 * POST /api/upload/:category
 *   - Admin-only
 *   - Accepts multipart/form-data with a single 'image' field
 *   - Returns { success: true, data: { path: '/uploads/<category>/<filename>' } }
 *
 * Supported categories: products, categories, payments
 */

const { Router } = require('express');
const fs = require('fs/promises');
const authenticate = require('../middlewares/authenticate');
const authorize = require('../middlewares/authorize');
const requirePermission = require('../middlewares/requirePermission');
const { createUpload, validateUploadedFileSignature } = require('../middlewares/upload');
const { BusinessRuleError } = require('../errors/AppError');
const { sendSuccess } = require('../utils/apiResponse');

const router = Router();

const ALLOWED_CATEGORIES = new Set(['products', 'categories', 'payments']);
const CATEGORY_PERMISSIONS = {
    products: 'MANAGE_PRODUCTS',
    categories: 'MANAGE_PRODUCTS',
    payments: 'MANAGE_PAYMENT_METHODS',
};

const validateAndRemoveInvalidUpload = async (file) => {
    try {
        await validateUploadedFileSignature(file, {
            code: 'INVALID_FILE_TYPE',
            message: 'Uploaded image content does not match its declared type.',
        });
    } catch (validationError) {
        // Multer has already written the file at this point. Only remove the
        // exact file created for this request; never derive a path from user
        // input or touch previously saved uploads.
        await fs.unlink(file.path).catch(() => undefined);
        throw validationError;
    }
};

// All upload routes require auth + admin
router.use(authenticate);
router.use(authorize('ADMIN', 'SUPERVISOR'));

/**
 * @route  POST /api/upload/:category
 * @desc   Upload a single image for the given category
 * @access Admin
 */
router.post('/:category', (req, res, next) => {
    const { category } = req.params;

    if (!ALLOWED_CATEGORIES.has(category)) {
        return next(
            new BusinessRuleError(
                `Invalid upload category '${category}'. Allowed: ${[...ALLOWED_CATEGORIES].join(', ')}`,
                'INVALID_UPLOAD_CATEGORY'
            )
        );
    }

    return requirePermission(CATEGORY_PERMISSIONS[category])(req, res, next);
}, (req, res, next) => {
    const { category } = req.params;
    const upload = createUpload(category);
    upload.single('image')(req, res, async (err) => {
        if (err) return next(err);

        if (!req.file) {
            return next(
                new BusinessRuleError('No image file provided.', 'MISSING_FILE')
            );
        }

        try {
            await validateAndRemoveInvalidUpload(req.file);
        } catch (validationError) {
            return next(validationError);
        }

        const relativePath = `/uploads/${category}/${req.file.filename}`;
        return sendSuccess(res, { path: relativePath }, 'Image uploaded successfully.');
    });
});

module.exports = router;
module.exports._test = { validateAndRemoveInvalidUpload };
