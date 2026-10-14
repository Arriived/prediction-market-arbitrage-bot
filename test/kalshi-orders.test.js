import { jest } from '@jest/globals';
import { createKalshiOrder } from '../src/kalshi-orders.js';

function setup() {
    const getHeaders = jest.fn(() => ({ 'KALSHI-ACCESS-KEY': 'test-key' }));
    const client = { ensureAuth: jest.fn(() => ({ getHeaders })) };
    const request = jest.fn(async () => ({
        ok: true,
        json: async () => ({ order_id: 'order-1', fill_count: '12.00', remaining_count: '0.00' })
    }));
    return { client, request, getHeaders };
}

test.each([
    ['buy', 'MARKET', 'bid', '0.4000'],
    ['buy', 'MARKET-NO', 'ask', '0.6000'],
    ['sell', 'MARKET', 'ask', '0.4000'],
    ['sell', 'MARKET-NO', 'bid', '0.6000']
])('%s %s maps to the correct YES-book direction', async (side, outcomeId, bookSide, price) => {
    const { client, request, getHeaders } = setup();
    const result = await createKalshiOrder(client, { marketId: 'MARKET', outcomeId, side, amount: 12, price: 0.4 }, request);
    expect(result).toEqual({ id: 'order-1', filled: 12, remaining: 0 });
    expect(getHeaders).toHaveBeenCalledWith('POST', '/trade-api/v2/portfolio/events/orders');
    expect(request).toHaveBeenCalledTimes(1);
    const [url, options] = request.mock.calls[0];
    expect(url).toBe('https://external-api.kalshi.com/trade-api/v2/portfolio/events/orders');
    expect(options.method).toBe('POST');
    expect(options.headers['KALSHI-ACCESS-KEY']).toBe('test-key');
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(options.body)).toEqual({
        ticker: 'MARKET', client_order_id: expect.any(String), side: bookSide, count: '12.00', price,
        time_in_force: side === 'buy' ? 'fill_or_kill' : 'immediate_or_cancel',
        self_trade_prevention_type: 'taker_at_cross', reduce_only: side === 'sell', exchange_index: -1
    });
});

test.each([
    { outcomeId: 'OTHER' }, { amount: 0 }, { amount: 1.5 }, { amount: Infinity },
    { side: 'invalid' }, { price: 0 }, { price: 1 }, { price: NaN }, { price: 0.12345 }
])('rejects invalid order parameters before signing or sending: %p', async override => {
    const { client, request } = setup();
    await expect(createKalshiOrder(client, {
        marketId: 'MARKET', outcomeId: 'MARKET', side: 'buy', amount: 12, price: 0.4, ...override
    }, request)).rejects.toThrow();
    expect(client.ensureAuth).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
});

test('does not retry a rejected order submission', async () => {
    const { client, request } = setup();
    request.mockResolvedValue({ ok: false, status: 429 });
    await expect(createKalshiOrder(client, {
        marketId: 'MARKET', outcomeId: 'MARKET-NO', side: 'buy', amount: 12, price: 0.4
    }, request)).rejects.toThrow('429');
    expect(request).toHaveBeenCalledTimes(1);
});

test('preserves an unfilled response for reconciliation', async () => {
    const { client, request } = setup();
    request.mockResolvedValue({ ok: true, json: async () => ({ order_id: 'unfilled', fill_count: '0.00', remaining_count: '0.00' }) });
    expect(await createKalshiOrder(client, {
        marketId: 'MARKET', outcomeId: 'MARKET', side: 'sell', amount: 12
    }, request)).toEqual({ id: 'unfilled', filled: 0, remaining: 0 });
});
