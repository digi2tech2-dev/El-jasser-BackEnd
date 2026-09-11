'use strict';

const config = require('../config/config');
const { startDefaultSettingsSeed } = require('../shared/startup/defaultSettingsSeed');
const { startServer } = require('../server');
const { sendEmail } = require('../services/email.service');
const whatsappService = require('../modules/whatsapp/whatsapp.service');

describe('SAFE_LOCAL_PRODUCTION_MODE', () => {
    const originalSafeMode = config.safeLocalProductionMode;
    const originalJobs = process.env.BACKGROUND_JOBS_ENABLED;
    const originalWhatsApp = process.env.WHATSAPP_AUTO_INIT;

    afterEach(() => {
        config.safeLocalProductionMode = originalSafeMode;
        if (originalJobs === undefined) delete process.env.BACKGROUND_JOBS_ENABLED;
        else process.env.BACKGROUND_JOBS_ENABLED = originalJobs;
        if (originalWhatsApp === undefined) delete process.env.WHATSAPP_AUTO_INIT;
        else process.env.WHATSAPP_AUTO_INIT = originalWhatsApp;
    });

    test('skips implicit settings seed in safe mode', () => {
        const seed = jest.fn();
        expect(startDefaultSettingsSeed({ safeLocalProductionMode: true, seed })).toBe(false);
        expect(seed).not.toHaveBeenCalled();
    });

    test('overrides jobs and WhatsApp initialization without opening a listener', async () => {
        config.safeLocalProductionMode = true;
        const appInstance = { listen: jest.fn((_port, handler) => { handler(); return { close: jest.fn() }; }) };
        const fulfillment = { start: jest.fn(), stop: jest.fn() };
        const providerSync = { start: jest.fn(), stop: jest.fn() };
        const whatsapp = { initializeWhatsAppClient: jest.fn(), destroyWhatsAppClient: jest.fn().mockResolvedValue() };

        await startServer({ appInstance, connectDatabase: jest.fn(), fulfillment, providerSync, whatsapp, registerProcessHandlers: false, exitOnFailure: false });
        expect(fulfillment.start).not.toHaveBeenCalled();
        expect(providerSync.start).not.toHaveBeenCalled();
        expect(whatsapp.initializeWhatsAppClient).not.toHaveBeenCalled();
    });

    test('keeps existing disabled startup flags effective outside safe mode', async () => {
        config.safeLocalProductionMode = false;
        process.env.BACKGROUND_JOBS_ENABLED = 'false';
        process.env.WHATSAPP_AUTO_INIT = 'false';
        const appInstance = { listen: jest.fn((_port, handler) => { handler(); return { close: jest.fn() }; }) };
        const fulfillment = { start: jest.fn(), stop: jest.fn() };
        const providerSync = { start: jest.fn(), stop: jest.fn() };
        const whatsapp = { initializeWhatsAppClient: jest.fn(), destroyWhatsAppClient: jest.fn().mockResolvedValue() };

        await startServer({ appInstance, connectDatabase: jest.fn(), fulfillment, providerSync, whatsapp, registerProcessHandlers: false, exitOnFailure: false });
        expect(fulfillment.start).not.toHaveBeenCalled();
        expect(providerSync.start).not.toHaveBeenCalled();
        expect(whatsapp.initializeWhatsAppClient).not.toHaveBeenCalled();
    });

    test('makes outbound email and WhatsApp notifications no-ops', async () => {
        config.safeLocalProductionMode = true;
        await expect(sendEmail({ to: 'nobody@example.invalid', subject: 'test', text: 'test' })).resolves.toBeUndefined();
        await expect(whatsappService.initializeWhatsAppClient()).resolves.toEqual(expect.any(Object));
        await expect(whatsappService.sendAdminNotification('must not send')).resolves.toBeNull();
    });
});
