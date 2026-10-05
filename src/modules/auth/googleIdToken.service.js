'use strict';

const { OAuth2Client } = require('google-auth-library');
const config = require('../../config/config');
const { AuthenticationError } = require('../../shared/errors/AppError');

let client = null;

const verifyGoogleIdToken = async (idToken) => {
    if (!config.google.webClientId) {
        throw new AuthenticationError('Native Google Sign-In is not configured on this server.');
    }

    try {
        client = client || new OAuth2Client(config.google.webClientId);
        const ticket = await client.verifyIdToken({
            idToken: String(idToken || ''),
            audience: config.google.webClientId,
        });
        const payload = ticket.getPayload();
        if (!payload?.sub || !payload?.email || payload.email_verified !== true) {
            throw new Error('Google identity is missing a verified email.');
        }
        return payload;
    } catch (_err) {
        throw new AuthenticationError('Google ID token is invalid or expired.');
    }
};

module.exports = { verifyGoogleIdToken };
