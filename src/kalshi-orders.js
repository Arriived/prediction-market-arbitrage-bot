import { randomUUID } from 'node:crypto';

// The pinned pmxt Kalshi order mapper ignores outcomeId. Use Kalshi's documented
// single YES book instead: buying NO is an ask at the complementary YES price.
// https://docs.kalshi.com/api-reference/orders/create-order-v2
export async function createKalshiOrder(client, params, request = globalThis.fetch) {
    const isNo = params.outcomeId === `${params.marketId}-NO`;
    if ((!isNo && params.outcomeId !== params.marketId) || !params.marketId) {
        throw new Error('Kalshi outcome does not belong to the selected market');
    }
    if (!['buy', 'sell'].includes(params.side) || !Number.isSafeInteger(params.amount) || params.amount < 1) {
        throw new Error('Invalid Kalshi order side or contract count');
    }
    const buying = params.side === 'buy';
    const outcomePrice = params.price ?? (buying ? 0.9999 : 0.0001);
    const ticks = Math.round(outcomePrice * 10000);
    if (!Number.isFinite(outcomePrice) || ticks <= 0 || ticks >= 10000 ||
        Math.abs(ticks - outcomePrice * 10000) > 1e-6) {
        throw new Error('Kalshi price must be between zero and one with at most four decimal places');
    }
    const path = '/trade-api/v2/portfolio/events/orders';
    const body = {
        ticker: params.marketId,
        client_order_id: randomUUID(),
        side: buying !== isNo ? 'bid' : 'ask',
        count: params.amount.toFixed(2),
        price: ((isNo ? 10000 - ticks : ticks) / 10000).toFixed(4),
        time_in_force: buying ? 'fill_or_kill' : 'immediate_or_cancel',
        self_trade_prevention_type: 'taker_at_cross',
        reduce_only: !buying,
        exchange_index: -1
    };
    const response = await request(`https://external-api.kalshi.com${path}`, {
        method: 'POST',
        headers: { ...client.ensureAuth().getHeaders('POST', path), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`Kalshi order request failed (${response.status})`);
    const order = await response.json();
    return {
        id: order.order_id,
        filled: Number(order.fill_count),
        remaining: Number(order.remaining_count)
    };
}
