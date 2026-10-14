import pmxt from 'pmxtjs';
import { matchOutcomes } from './matcher.js';
import { findArbitrageOpportunities, getBestOpportunity } from './arbitrage.js';
import { createKalshiOrder } from './kalshi-orders.js';

export class ArbitrageBot {
    constructor(config) {
        this.config = config;
        this.polymarket = new pmxt.polymarket({ privateKey: config.polymarketPrivateKey });
        this.kalshi = new pmxt.kalshi({ apiKey: config.kalshiApiKey, privateKey: config.kalshiApiSecret });
        this.kalshi.createOrder = params => createKalshiOrder(this.kalshi, params);
        this.currentPosition = null;
    }

    extractMarketId(url, platform) {
        if (platform === 'polymarket') {
            const match = url.match(/event\/([^/?]+)/);
            return match ? match[1] : null;
        } else {
            // Kalshi: extract the last segment for the specific event ticker
            const parts = url.split('/');
            return parts[parts.length - 1].toUpperCase();
        }
    }

    async fetchMarkets() {
        const polymarketId = this.extractMarketId(this.config.polymarketUrl, 'polymarket');
        const kalshiId = this.extractMarketId(this.config.kalshiUrl, 'kalshi');

        const [polymarketMarkets, kalshiMarkets] = await Promise.all([
            this.polymarket.getMarketsBySlug(polymarketId),
            this.kalshi.getMarketsBySlug(kalshiId)
        ]);

        return { polymarketMarkets, kalshiMarkets };
    }

    parseOutcomes(markets, platform) {
        return markets
            .filter(m => m.outcomes && m.outcomes.length === 2)
            .map(market => {
                // Find YES and NO outcomes by label, don't assume array order
                const explicitYes = market.outcomes.find(o => o.label?.trim().toLowerCase() === 'yes' || o.side?.toLowerCase() === 'yes');
                const explicitNo = market.outcomes.find(o => o.label?.trim().toLowerCase() === 'no' || o.side?.toLowerCase() === 'no');
                const yesOutcome = explicitYes || market.outcomes.find(o => o !== explicitNo);
                const noOutcome = explicitNo || market.outcomes.find(o => o !== yesOutcome);
                if (!yesOutcome || !noOutcome || yesOutcome === noOutcome) return null;

                // A generic YES label needs the market's proposition for matching.
                const label = yesOutcome.label;
                const title = label?.trim().toLowerCase() === 'yes' ? market.title : label;
                if (typeof title !== 'string' || !title.trim()) return null;
                const yesId = yesOutcome.id;
                const noId = noOutcome.id;
                const yesPrice = Number((yesOutcome.price * 100).toFixed(2));
                const noPrice = Number((noOutcome.price * 100).toFixed(2));

                return {
                    title,
                    marketId: market.id,
                    yesId,
                    noId,
                    yesPrice,
                    noPrice,
                    platform,
                    volume: market.volume || 0,
                };
            }).filter(Boolean);
    }

    async executeTrade(platform, marketId, outcomeId, side, contracts, priceCents) {
        if (this.config.dryRun) {
            console.log(`   [DRY RUN] ${platform} ${side.toUpperCase()} ${contracts} contracts on ${marketId} (Outcome: ${outcomeId})`);
            return { success: true, orderId: 'dry-run-' + Date.now() };
        }

        const client = platform === 'polymarket' ? this.polymarket : this.kalshi;
        let order;
        try {
            order = await client.createOrder({
                marketId,
                outcomeId,
                side: side.toLowerCase(), // 'buy' or 'sell'
                amount: contracts,
                type: 'market',
                ...(priceCents == null ? {} : { price: priceCents / 100 })
            });
            if (!order || order.id == null || order.id === '') {
                throw new Error('Order response has no order ID; verify the venue before retrying');
            }
            let filled = Number(order.filled);
            if ((!Number.isFinite(filled) || Math.abs(filled - contracts) > 1e-8) &&
                platform === 'polymarket' && typeof client.fetchOrder === 'function') {
                filled = Number((await client.fetchOrder(order.id)).filled);
            }
            if (!Number.isFinite(filled) || Math.abs(filled - contracts) > 1e-8) {
                throw new Error(`Full fill is unconfirmed for order ${order.id}; reconciliation required`);
            }
            return { success: true, orderId: order.id };
        } catch (error) {
            console.error(`   [ERROR] ${error.message}`);
            return { success: false, orderId: order?.id, error: error.message };
        }
    }

    async executeArbitrage(opportunity) {
        if (this.currentPosition) return false;
        console.log(`\n[EXECUTE] ${opportunity.outcome}: ${opportunity.description} | Profit: ${opportunity.profit.toFixed(2)}¢`);

        const tradeAmountCents = this.config.tradingMode === 'YOLO' ? 1000 : this.config.tradeAmountCents;

        // Calculate contract amount based on price (contracts = tradeAmountCents / priceInCents)
        const polyPrice = opportunity.polymarketSide === 'YES' ? opportunity.polymarketOutcome.yesPrice : opportunity.polymarketOutcome.noPrice;
        const kalshiPrice = opportunity.kalshiSide === 'YES' ? opportunity.kalshiOutcome.yesPrice : opportunity.kalshiOutcome.noPrice;

        if (![polyPrice, kalshiPrice].every(price => Number.isFinite(price) && price > 0 && price < 100) ||
            !Number.isFinite(tradeAmountCents) || tradeAmountCents <= 0) return false;
        // Both outcomes must have the same payout quantity. Keep each leg within its budget.
        const contracts = Math.floor(tradeAmountCents / Math.max(polyPrice, kalshiPrice));
        if (contracts < 1) return false;
        const polyContracts = contracts;
        const kalshiContracts = contracts;

        const polyOutcomeId = opportunity.polymarketSide === 'YES' ? opportunity.polymarketOutcome.yesId : opportunity.polymarketOutcome.noId;
        const kalshiOutcomeId = opportunity.kalshiSide === 'YES' ? opportunity.kalshiOutcome.yesId : opportunity.kalshiOutcome.noId;

        const [polyTrade, kalshiTrade] = await Promise.all([
            this.executeTrade('polymarket', opportunity.polymarketOutcome.marketId, polyOutcomeId, 'buy', polyContracts, polyPrice),
            this.executeTrade('kalshi', opportunity.kalshiOutcome.marketId, kalshiOutcomeId, 'buy', kalshiContracts, kalshiPrice)
        ]);


        // A failed request can still have reached the venue. Retain the attempted
        // position and block further writes until an operator reconciles the fills.
        this.currentPosition = {
            opportunity,
            polymarketOrderId: polyTrade.orderId,
            kalshiOrderId: kalshiTrade.orderId,
            shares: {
                polymarket: polyContracts,
                kalshi: kalshiContracts
            },
            outcomeIds: {
                polymarket: polyOutcomeId,
                kalshi: kalshiOutcomeId
            },
            entryPrices: {
                polymarket: polyPrice,
                kalshi: kalshiPrice
            },
            entryTime: Date.now(),
            requiresReconciliation: !polyTrade.success || !kalshiTrade.success,
            entryResults: { polymarket: polyTrade, kalshi: kalshiTrade }
        };

    if (polyTrade.success && kalshiTrade.success) {
        return true;
    }
    console.error('[RECONCILIATION REQUIRED] Entry outcome is uncertain. Trading paused; verify fills on both venues before restarting.');
    return false;
}

calculateCurrentPnL(polymarketOutcomes, kalshiOutcomes) {
    if (!this.currentPosition) return 0;

    // Find current prices for the position
    const polyNow = polymarketOutcomes.find(o => o.marketId === this.currentPosition.opportunity.polymarketOutcome.marketId);
    const kalshiNow = kalshiOutcomes.find(o => o.marketId === this.currentPosition.opportunity.kalshiOutcome.marketId);

    if (!polyNow || !kalshiNow) return 0;

    // Identify which price we need (YES or NO)
    const polySide = this.currentPosition.opportunity.polymarketSide;
    const kalshiSide = this.currentPosition.opportunity.kalshiSide;

    const polyCurrentPrice = polySide === 'YES' ? polyNow.yesPrice : polyNow.noPrice;
    const kalshiCurrentPrice = kalshiSide === 'YES' ? kalshiNow.yesPrice : kalshiNow.noPrice;

    // Value = Shares * Current Price
    const polyValue = this.currentPosition.shares.polymarket * polyCurrentPrice;
    const kalshiValue = this.currentPosition.shares.kalshi * kalshiCurrentPrice;

    // Cost = Shares * Entry Price
    const polyCost = this.currentPosition.shares.polymarket * this.currentPosition.entryPrices.polymarket;
    const kalshiCost = this.currentPosition.shares.kalshi * this.currentPosition.entryPrices.kalshi;

    return (polyValue + kalshiValue) - (polyCost + kalshiCost);
}

shouldExitPosition(opportunities) {
    if (!this.currentPosition) return false;

    // Exit if current opportunity is gone or unprofitable
    const currentOpp = opportunities.find(opp => opp.outcome === this.currentPosition.opportunity.outcome);
    if (!currentOpp || currentOpp.profit < this.config.minProfitCents) return true;

    // Exit if a BETTER opportunity exists (Rotation)
    const bestOpp = getBestOpportunity(opportunities);
    if (bestOpp && bestOpp.profit > currentOpp.profit) {
        console.log(`[ROTATION] Found better opportunity: ${bestOpp.outcome} (${bestOpp.profit.toFixed(2)}¢) > ${currentOpp.outcome} (${currentOpp.profit.toFixed(2)}¢)`);
        return true;
    }

    return false;
}

async exitPosition() {
    if (!this.currentPosition || this.currentPosition.requiresReconciliation) return;
    const heldTime = Math.round((Date.now() - this.currentPosition.entryTime) / 1000);
    console.log(`\n[EXITING] ${this.currentPosition.opportunity.outcome} (held ${heldTime}s) - Executing SELL orders...`);

    const { outcomeIds, shares, opportunity } = this.currentPosition;

    const [polyExit, kalshiExit] = await Promise.all([
        this.executeTrade('polymarket', opportunity.polymarketOutcome.marketId, outcomeIds.polymarket, 'sell', shares.polymarket),
        this.executeTrade('kalshi', opportunity.kalshiOutcome.marketId, outcomeIds.kalshi, 'sell', shares.kalshi)
    ]);

    if (polyExit.success && kalshiExit.success) {
        console.log(`[SOLD] Position closed successfully.\n`);
        this.currentPosition = null;
    } else {
        console.error('[RECONCILIATION REQUIRED] Exit outcome is uncertain. Trading paused; verify fills on both venues before restarting.');
        this.currentPosition.requiresReconciliation = true;
        this.currentPosition.exitResults = { polymarket: polyExit, kalshi: kalshiExit };
    }
}

async poll() {
    if (this.polling || this.currentPosition?.requiresReconciliation) return;
    this.polling = true;
    try {
        const { polymarketMarkets, kalshiMarkets } = await this.fetchMarkets();
        const polymarketOutcomes = this.parseOutcomes(polymarketMarkets, 'polymarket');
        const kalshiOutcomes = this.parseOutcomes(kalshiMarkets, 'kalshi');
        const matches = matchOutcomes(polymarketOutcomes, kalshiOutcomes, this.config.matchingThreshold);
        const allOpportunities = findArbitrageOpportunities(matches, this.config.minProfitCents)
            .filter(opp => {
                // Skip markets where either side has a price at or below the threshold
                const polyYes = opp.polymarketOutcome.yesPrice;
                const polyNo = opp.polymarketOutcome.noPrice;
                const kalshiYes = opp.kalshiOutcome.yesPrice;
                const kalshiNo = opp.kalshiOutcome.noPrice;

                return polyYes > this.config.minPriceThreshold &&
                    polyNo > this.config.minPriceThreshold &&
                    kalshiYes > this.config.minPriceThreshold &&
                    kalshiNo > this.config.minPriceThreshold;
            })
            .map(opp => ({
                ...opp,
                totalVolume: (opp.polymarketOutcome.volume || 0) + (opp.kalshiOutcome.volume || 0)
            }))
            .sort((a, b) => b.totalVolume - a.totalVolume); // First rank by volume

        // Then take top N and re-sort by profit
        const topOpportunities = allOpportunities
            .slice(0, this.config.topNOpportunities)
            .sort((a, b) => b.profit - a.profit);

        // Calculate current unrealized PnL
        const currentPnL = this.calculateCurrentPnL(polymarketOutcomes, kalshiOutcomes);
        console.log(`[CURRENT PnL: ${currentPnL.toFixed(2)}¢]`);

        if (topOpportunities.length > 0) {
            console.log(`[TOP ${topOpportunities.length} OPPORTUNITIES BY PROFIT (FROM TOP VOLUME MARKETS)]`);
            topOpportunities.forEach((opp, i) => {
                console.log(`  ${i + 1}. ${opp.outcome}: ${opp.description} | Profit: ${opp.profit.toFixed(2)}¢ | Vol: $${(opp.totalVolume || 0).toLocaleString()}`);
            });
            console.log('');
        }

        if (this.shouldExitPosition(topOpportunities)) await this.exitPosition();
        if (!this.currentPosition && topOpportunities.length > 0) {
            await this.executeArbitrage(getBestOpportunity(topOpportunities));
        }
    } catch (error) {
        console.error('[ERROR]', error.message);
        console.error(error.stack);
    } finally {
        this.polling = false;
    }
}

async start() {
    console.log(`[BOT STARTED] Polling every ${this.config.pollIntervalSeconds}s | Min profit: ${this.config.minProfitCents}¢ | Mode: ${this.config.tradingMode} | Dry run: ${this.config.dryRun ? 'YES' : 'NO'}\n`);
    await this.poll();
    this.pollInterval = setInterval(async () => {
        console.log(`[${new Date().toLocaleTimeString()}]`);
        await this.poll();
    }, this.config.pollIntervalSeconds * 1000);
}

stop() {
    if (this.pollInterval) clearInterval(this.pollInterval);
    console.log('\n[BOT STOPPED]');
}
}
