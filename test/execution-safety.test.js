import { jest } from '@jest/globals';

jest.unstable_mockModule('pmxtjs', () => ({ default: {} }));
const { ArbitrageBot } = await import('../src/bot.js');

function setup() {
    const bot = Object.create(ArbitrageBot.prototype);
    bot.config = { tradingMode: 'CONSERVATIVE', tradeAmountCents: 1000, dryRun: false, topNOpportunities: 5 };
    bot.polymarket = { createOrder: jest.fn(async ({ amount }) => ({ id: 'poly-order', filled: amount })) };
    bot.kalshi = { createOrder: jest.fn(async ({ amount }) => ({ id: 'kalshi-order', filled: amount })) };
    bot.currentPosition = null;
    const opportunity = {
        outcome: 'Event', description: 'Matched pair', profit: 10,
        polymarketSide: 'YES', kalshiSide: 'NO',
        polymarketOutcome: { marketId: 'p', yesId: 'py', yesPrice: 40 },
        kalshiOutcome: { marketId: 'k', noId: 'kn', noPrice: 50 }
    };
    return { bot, opportunity };
}

test('buys equal contract quantities within both leg budgets', async () => {
    const { bot, opportunity } = setup();
    await bot.executeArbitrage(opportunity);
    expect(bot.currentPosition.shares).toEqual({ polymarket: 20, kalshi: 20 });
});

test.each([0, NaN, Infinity, -1])('does not submit a trade at invalid price %s', async price => {
    const { bot, opportunity } = setup();
    opportunity.polymarketOutcome.yesPrice = price;
    expect(await bot.executeArbitrage(opportunity)).toBe(false);
    expect(bot.polymarket.createOrder).not.toHaveBeenCalled();
    expect(bot.kalshi.createOrder).not.toHaveBeenCalled();
});

test('does not submit zero-contract orders', async () => {
    const { bot, opportunity } = setup();
    bot.config.tradeAmountCents = 1;
    expect(await bot.executeArbitrage(opportunity)).toBe(false);
    expect(bot.polymarket.createOrder).not.toHaveBeenCalled();
});

test('retains an uncertain entry and blocks additional orders', async () => {
    const { bot, opportunity } = setup();
    bot.kalshi.createOrder.mockRejectedValue(new Error('Request timed out'));
    expect(await bot.executeArbitrage(opportunity)).toBe(false);
    expect(bot.currentPosition.requiresReconciliation).toBe(true);
    await bot.executeArbitrage(opportunity);
    expect(bot.polymarket.createOrder).toHaveBeenCalledTimes(1);
});

test('an incomplete order response requires reconciliation', async () => {
    const { bot, opportunity } = setup();
    bot.polymarket.createOrder.mockResolvedValue({});
    expect(await bot.executeArbitrage(opportunity)).toBe(false);
    expect(bot.currentPosition.requiresReconciliation).toBe(true);
});

test('an accepted order is not treated as a complete fill', async () => {
    const { bot, opportunity } = setup();
    bot.polymarket.createOrder.mockResolvedValue({ id: 'partial', filled: 2 });
    bot.polymarket.fetchOrder = jest.fn().mockResolvedValue({ filled: 2 });
    expect(await bot.executeArbitrage(opportunity)).toBe(false);
    expect(bot.currentPosition.requiresReconciliation).toBe(true);
    expect(bot.currentPosition.polymarketOrderId).toBe('partial');
});

test('retains failed exit state without retrying potentially accepted orders', async () => {
    const { bot, opportunity } = setup();
    await bot.executeArbitrage(opportunity);
    const position = bot.currentPosition;
    bot.kalshi.createOrder.mockRejectedValue(new Error('Request timed out'));
    await bot.exitPosition();
    expect(bot.currentPosition).toBe(position);
    expect(position.requiresReconciliation).toBe(true);
    await bot.exitPosition();
    expect(bot.polymarket.createOrder).toHaveBeenCalledTimes(2);
    bot.fetchMarkets = jest.fn();
    await bot.poll();
    expect(bot.fetchMarkets).not.toHaveBeenCalled();
});

test('does not overlap asynchronous polling cycles', async () => {
    const { bot } = setup();
    let finishFetch;
    bot.fetchMarkets = jest.fn(() => new Promise(resolve => { finishFetch = resolve; }));
    const first = bot.poll();
    await bot.poll();
    expect(bot.fetchMarkets).toHaveBeenCalledTimes(1);
    finishFetch({ polymarketMarkets: [], kalshiMarkets: [] });
    await first;
    expect(bot.polling).toBe(false);
});

test('generic YES labels retain their distinct market propositions', () => {
    const { bot } = setup();
    const markets = ['Candidate A wins', 'Candidate B wins'].map((title, index) => ({
        id: `market-${index}`, title,
        outcomes: [{ id: `${index}-yes`, label: 'Yes', price: 0.4 }, { id: `${index}-no`, label: 'No', price: 0.6 }]
    }));
    expect(bot.parseOutcomes(markets, 'polymarket').map(outcome => outcome.title)).toEqual(markets.map(market => market.title));
});

test('multi-outcome markets are not treated as complementary binary outcomes', () => {
    const { bot } = setup();
    expect(bot.parseOutcomes([{ outcomes: [{}, {}, {}] }], 'polymarket')).toEqual([]);
});

test('a single labelled side always uses the other outcome as its complement', () => {
    const { bot } = setup();
    const outcomes = bot.parseOutcomes([{
        id: 'market', title: 'Candidate wins',
        outcomes: [{ id: 'no', label: 'Complement', price: 0.6 }, { id: 'yes', label: 'Yes', price: 0.4 }]
    }], 'polymarket');
    expect(outcomes[0]).toMatchObject({ yesId: 'yes', noId: 'no', yesPrice: 40, noPrice: 60 });
});
