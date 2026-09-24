'use strict';

const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const {
    validateUploadedFileSignature,
} = require('../shared/middlewares/upload');
const { _test: uploadRouteTest } = require('../shared/routes/upload.routes');

describe('upload signature validation', () => {
    it('accepts valid public image signatures', async () => {
        await expect(validateUploadedFileSignature({
            mimetype: 'image/png',
            buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
        })).resolves.toBeUndefined();

        await expect(validateUploadedFileSignature({
            mimetype: 'image/jpeg',
            buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]),
        })).resolves.toBeUndefined();

        await expect(validateUploadedFileSignature({
            mimetype: 'image/webp',
            buffer: Buffer.from('RIFFxxxxWEBPVP8 ', 'ascii'),
        })).resolves.toBeUndefined();
    });

    it('rejects renamed non-image bytes even when MIME claims image', async () => {
        await expect(validateUploadedFileSignature({
            mimetype: 'image/png',
            buffer: Buffer.from('MZ executable bytes'),
        })).rejects.toMatchObject({ code: 'INVALID_FILE_TYPE' });
    });

    it('removes a spoofed payment image after generic-route signature rejection', async () => {
        const uploadPath = path.join(os.tmpdir(), `spoofed-payment-${Date.now()}.png`);
        await fs.writeFile(uploadPath, 'not a PNG');

        await expect(uploadRouteTest.validateAndRemoveInvalidUpload({
            mimetype: 'image/png',
            path: uploadPath,
        })).rejects.toMatchObject({ code: 'INVALID_FILE_TYPE' });

        await expect(fs.access(uploadPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('allows PDF signatures only when explicitly enabled', async () => {
        const pdfFile = {
            mimetype: 'application/pdf',
            buffer: Buffer.from('%PDF-1.7\n'),
        };

        await expect(validateUploadedFileSignature(pdfFile)).rejects.toMatchObject({ code: 'INVALID_FILE_TYPE' });
        await expect(validateUploadedFileSignature(pdfFile, { allowPdf: true })).resolves.toBeUndefined();
    });
});
