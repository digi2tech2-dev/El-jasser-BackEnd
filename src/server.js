'use strict';

require('dotenv').config();

const app = require('./app');
const config = require('./config/config');
const connectDB = require('./config/database');
const fulfillmentJob = require('./modules/orders/fulfillmentJob');
const syncProvidersJob = require('./modules/providers/syncProvidersJob');
const whatsappService = require('./modules/whatsapp/whatsapp.service');

const isExplicitlyDisabled = (value) => String(value || '').trim().toLowerCase() === 'false';


const startServer = async ({
    appInstance = app,
    connectDatabase = connectDB,
    fulfillment = fulfillmentJob,
    providerSync = syncProvidersJob,
    whatsapp = whatsappService,
    registerProcessHandlers = true,
    exitOnFailure = true,
} = {}) => {
    try {
        // 1. Connect to MongoDB first
        await connectDatabase();

        // 2. Then start listening
        const server = appInstance.listen(config.port, () => {
            console.log('');
            console.log('═══════════════════════════════════════════════════════');
            console.log(`  🚀  KA API`);
            console.log(`  🌍  Environment : ${config.env}`);
            console.log(`  📡  Port        : ${config.port}`);
            console.log(`  🔗  Base URL    : ${process.env.APP_URL || `http://localhost:${config.port}`}/api`);
            console.log('═══════════════════════════════════════════════════════');
            console.log('');
        });

        // Safe local mode overrides all legacy startup controls. Outside that
        // mode, preserve the existing BACKGROUND_JOBS_ENABLED and
        // WHATSAPP_AUTO_INIT behavior unchanged.
        if (config.safeLocalProductionMode) {
            console.warn('[Startup] SAFE_LOCAL_PRODUCTION_MODE=true: jobs and WhatsApp initialization are disabled.');
        } else {
            if (!isExplicitlyDisabled(process.env.BACKGROUND_JOBS_ENABLED)) {
                fulfillment.start();
                providerSync.start();
            } else {
                console.log('[Startup] Background jobs are disabled by BACKGROUND_JOBS_ENABLED=false.');
            }

            if (!isExplicitlyDisabled(process.env.WHATSAPP_AUTO_INIT)) {
                whatsapp.initializeWhatsAppClient().catch((err) => {
                    console.error('[WhatsApp] startup initialization failed:', err.message);
                });
            } else {
                console.log('[Startup] WhatsApp auto-init is disabled by WHATSAPP_AUTO_INIT=false.');
            }
        }

        if (typeof process.send === 'function') {
            process.send('ready');
        }

        // ── Graceful Shutdown ─────────────────────────────────────────────────────
        const gracefulShutdown = (signal) => {
            console.log(`\n⚠️  Received ${signal}. Shutting down gracefully...`);

            // Stop both cron jobs before closing HTTP
            fulfillment.stop();
            providerSync.stop();
            whatsapp.destroyWhatsAppClient().catch((err) => {
                console.warn('[WhatsApp] shutdown cleanup failed:', err.message);
            });

            server.close(async () => {
                console.log('✅ HTTP server closed.');
                const mongoose = require('mongoose');
                await mongoose.connection.close();
                console.log('✅ MongoDB connection closed.');
                process.exit(0);
            });

            // Force exit after 10s if graceful shutdown stalls
            setTimeout(() => {
                console.error('❌ Graceful shutdown timed out. Forcing exit.');
                process.exit(1);
            }, 10_000);
        };

        if (registerProcessHandlers) {
            process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
            process.on('SIGINT', () => gracefulShutdown('SIGINT'));

            // ── Unhandled Rejections / Exceptions ─────────────────────────────────
            process.on('unhandledRejection', (reason) => {
                console.error('💥 Unhandled Promise Rejection:', reason);
                gracefulShutdown('unhandledRejection');
            });

            process.on('uncaughtException', (error) => {
                console.error('💥 Uncaught Exception:', error);
                process.exit(1);
            });
        }

        return server;
    } catch (error) {
        console.error('❌ Failed to start server:', error.message);
        if (exitOnFailure) process.exit(1);
        throw error;
    }
};

if (require.main === module) {
    startServer();
}

module.exports = { startServer };
