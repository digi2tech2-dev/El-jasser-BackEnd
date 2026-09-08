'use strict';

jest.mock('axios', () => ({
    create: jest.fn(),
}));

const axios = require('axios');
const {
    extractTargetId,
    hasTargetId,
    normalizeParamAliases,
} = require('../modules/providers/adapters/providerParams.helper');
const { AlkasrVipAdapter } = require('../modules/providers/adapters/alkasr.adapter');

describe('providerParams.helper', () => {
    it.each([
        ['playerId', 'player-123'],
        ['player_id', 'player-456'],
        ['uid', 'uid-789'],
        ['link', 'https://example.com/profile/abc'],
        ['target', 'target-abc'],
        ['ايدي المستخدم', '10026'],
        ['ايدى المستخدم', '10027'],
        ['معرف المستخدم', '10028'],
        ['ايدي-اللاعب', '10029'],
        ['يوزر ايدي', '10030'],
        ['رابط الحساب', 'https://example.com/account/10030'],
        ['Player ID', '10031'],
        ['User ID', '10032'],
        ['Account ID', '10033'],
        ['ID', '10034'],
    ])('extracts %s', (key, value) => {
        expect(extractTargetId({ [key]: ` ${value} ` })).toBe(value);
        expect(hasTargetId({ [key]: value })).toBe(true);
    });

    it('extracts display aliases after normalizing spaces and punctuation', () => {
        expect(extractTargetId({ 'ايديالمستخدم': '10035' })).toBe('10035');
        expect(extractTargetId({ 'Player.ID': '10036' })).toBe('10036');
    });

    it('returns null when missing or blank', () => {
        expect(extractTargetId({})).toBeNull();
        expect(extractTargetId({ playerId: '' })).toBeNull();
        expect(extractTargetId({ player_id: '   ' })).toBeNull();
        expect(extractTargetId({ target: true })).toBeNull();
        expect(hasTargetId({ uid: null })).toBe(false);
    });

    it('normalizes supported aliases into canonical playerId without mutating input', () => {
        const params = { uid: 'uid-123', amount: 10 };
        const normalized = normalizeParamAliases(params);

        expect(normalized).toEqual({ uid: 'uid-123', amount: 10, playerId: 'uid-123' });
        expect(params).toEqual({ uid: 'uid-123', amount: 10 });
    });

    it('uses plain id only when there is no reserved id context', () => {
        expect(extractTargetId({ id: 'target-only' })).toBe('target-only');
        expect(extractTargetId({ id: 'not-target', productId: 'provider-product' })).toBeNull();
        expect(extractTargetId({ id: 'not-target', orderId: 'order-1' })).toBeNull();
    });
});

describe('AlkasrVipAdapter target extraction', () => {
    let mockClient;

    const makeAdapter = () => new AlkasrVipAdapter({
        name: 'alkasr',
        baseUrl: 'https://alkasr.example.test',
        apiToken: 'token',
    });

    beforeEach(() => {
        mockClient = {
            get: jest.fn(),
            interceptors: {
                response: {
                    use: jest.fn(),
                },
            },
        };
        axios.create.mockReturnValue(mockClient);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it('does not call supplier when target is missing', async () => {
        const adapter = makeAdapter();

        const result = await adapter.placeOrder({ productId: 'game-pack', amount: 1 });

        expect(mockClient.get).not.toHaveBeenCalled();
        expect(result).toEqual({
            success: false,
            providerOrderId: null,
            providerStatus: 'Cancelled',
            rawResponse: {
                status: 'ERROR',
                msg: 'Missing provider target/player ID',
            },
            errorMessage: 'Missing provider target/player ID',
        });
    });

    it.each([
        ['player_id', 'player-1'],
        ['link', 'https://example.com/player/player-2'],
        ['uid', 'player-3'],
    ])('sends playerId when source key is %s', async (key, value) => {
        mockClient.get.mockResolvedValue({
            data: {
                status: 'OK',
                data: {
                    order_id: 12345,
                    status: 'wait',
                },
            },
        });
        const adapter = makeAdapter();

        const result = await adapter.placeOrder({
            productId: 'game-pack',
            amount: 2,
            [key]: value,
        });

        expect(result.success).toBe(true);
        expect(mockClient.get).toHaveBeenCalledTimes(1);
        expect(mockClient.get).toHaveBeenCalledWith(
            '/client/api/newOrder/game-pack/params',
            {
                params: expect.objectContaining({
                    qty: 2,
                    playerId: value,
                    order_uuid: expect.any(String),
                }),
            }
        );
    });
});
