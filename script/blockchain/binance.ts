import axios from "axios";
import * as bluebird from "bluebird";
import * as fs from "fs";
import * as path from "path";
import * as chalk from 'chalk';
import * as config from "../config";
import { ActionInterface, CheckStepInterface } from "../generic/interface";
import { Binance } from "../generic/blockchains";
import { readDirSync } from "../generic/filesystem";
import { readJsonFile } from "../generic/json";
import { TokenItem, Pair, createTokensList, writeToFileWithUpdate } from "../generic/tokenlists";
import {
    getChainAssetLogoPath,
    getChainAssetsPath,
    getChainDenylistPath,
    getChainTokenlistPath
} from "../generic/repo-structure";
import { CoinType } from "@trustwallet/wallet-core";
import { toSatoshis } from "../generic/numbers";
import { assetIdSymbol, logoURI, tokenType } from "../generic/asset";
import { TokenType } from "../generic/tokentype";

const binanceChain = "binance";
const binanceUrlTokenAssets = config.binanceUrlTokenAssets;
let cachedAssets = [];

async function retrieveBep2AssetList(): Promise<unknown[]> {
    console.log(`Retrieving token asset infos from: ${binanceUrlTokenAssets}`);
    const { assetInfoList } = await axios.get(binanceUrlTokenAssets).then(r => r.data);
    console.log(`Retrieved ${assetInfoList.length} token asset infos`);
    return assetInfoList
}

async function retrieveAssets(): Promise<unknown[]> {
    // cache results because of rate limit, used more than once
    if (cachedAssets.length == 0) {
        console.log(`Retrieving token infos`);
        const bep2assets = await axios.get(`${config.binanceDexURL}/v1/tokens?limit=1000`);
        const bep8assets = await axios.get(`${config.binanceDexURL}/v1/mini/tokens?limit=1000`);
        cachedAssets = bep2assets.data.concat(bep8assets.data);
    }
    console.log(`Using ${cachedAssets.length} assets`);
    return cachedAssets;
}

export async function retrieveAssetSymbols(): Promise<string[]> {
    const assets = await retrieveAssets();
    const symbols = assets.map(({ symbol }) => symbol);
    return symbols;
}

function fetchImage(url) {
    return axios.get(url, { responseType: "stream" })
        .then(r => r.data)
        .catch(err => {
            throw `Error fetchImage: ${url} ${err.message}`;
        });
}

/// Return: array with images to fetch; {asset, assetImg}
export function findImagesToFetch(assetInfoList: unknown[], denylist: string[]): unknown[] {
    const toFetch: unknown[] = [];
    console.log(`Checking for asset images to be fetched`);
    assetInfoList.forEach(({asset, assetImg}) => {
        process.stdout.write(`.${asset} `);
        if (assetImg) {
            if (denylist.indexOf(asset) != -1) {
                console.log();
                console.log(`${asset} is denylisted`);
            } else {
                const imagePath = getChainAssetLogoPath(binanceChain, asset);
                if (!fs.existsSync(imagePath)) {
                    console.log(chalk.red(`Missing image: ${asset}`));
                    toFetch.push({asset, assetImg});
                }
            }
        }
    });
    console.log();
    console.log(`${toFetch.length} asset image(s) to be fetched`);
    return toFetch;
}


async function fetchMissingImages(toFetch: unknown[]): Promise<string[]> {
    console.log(`Attempting to fetch ${toFetch.length} asset image(s)`);
    const fetchedAssets: string[] = [];
    await bluebird.each(toFetch, async ({ asset, assetImg }) => {
        if (assetImg) {
            const imagePath = getChainAssetLogoPath(binanceChain, asset);
            fs.mkdir(path.dirname(imagePath), err => {
                if (err && err.code != `EEXIST`) throw err;
            });
            await fetchImage(assetImg).then(buffer => {
                buffer.pipe(fs.createWriteStream(imagePath));
                fetchedAssets.push(asset)
                console.log(`Fetched image ${asset} ${imagePath} from ${assetImg}`)
            });
        }
    });
    console.log();
    return fetchedAssets;
}

export class BinanceAction implements ActionInterface {
    getName(): string { return "Binance chain"; }

    getSanityChecks(): CheckStepInterface[] {
        return [
            {
                getName: () => { return "Binance chain; assets must exist on chain"},
                check: async () => {
                    const errors = [];
                    const tokenSymbols = await retrieveAssetSymbols();
                    const assets = readDirSync(getChainAssetsPath(Binance));
                    assets.forEach(asset => {
                        if (!(tokenSymbols.indexOf(asset) >= 0)) {
                            errors.push(`Asset ${asset} missing on chain`);
                        }
                    });
                    console.log(`     ${assets.length} assets checked.`);
                    return [errors, []];
                }
            },
        ];
    }
    
    async updateAuto(): Promise<void> {
        // retrieve missing token images; BEP2 (bep8 not supported)
        const bep2InfoList = await retrieveBep2AssetList();
        const denylist: string[] = readJsonFile(getChainDenylistPath(binanceChain)) as string[];

        const toFetch = findImagesToFetch(bep2InfoList, denylist);
        const fetchedAssets = await fetchMissingImages(toFetch);

        if (fetchedAssets.length > 0) {
            console.log(`Fetched ${fetchedAssets.length} asset(s):`);
            fetchedAssets.forEach(asset => console.log(`  ${asset}`));
        }

        // binance chain list
        const tokenList = await generateBinanceTokensList();
        const list = createTokensList("BNB", tokenList,
            "2020-10-03T12:37:57.000+00:00", // use constants here to prevent changing time every time
            0, 1, 0);
        writeToFileWithUpdate(getChainTokenlistPath(Binance), list);
    }
}

class BinanceMarket {
    base_asset_symbol: string
    quote_asset_symbol: string
    lot_size: string
    tick_size: string
}

async function generateBinanceTokensList(): Promise<TokenItem[]> {
    const decimals = CoinType.decimals(CoinType.binance)
    const BNBSymbol = CoinType.symbol(CoinType.binance)
    const markets: [BinanceMarket] = await axios.get(`${config.binanceDexURL}/v1/markets?limit=10000`).then(r => r.data);
    const tokens = await axios.get(`${config.binanceDexURL}/v1/tokens?limit=10000`).then(r => r.data);
    const tokensMap = Object.assign({}, ...tokens.map(s => ({[s.symbol]: s})));
    const pairsMap = {}
    const pairsList = new Set();

    markets.forEach(market => {
        const key = market.quote_asset_symbol

        function pair(market: BinanceMarket): Pair {
            return new Pair(
                assetIdSymbol(market.base_asset_symbol, BNBSymbol, CoinType.binance),
                toSatoshis(market.lot_size, decimals),
                toSatoshis(market.tick_size, decimals)
            )
        }

        if (pairsMap[key]) {
            const newList = pairsMap[key]
            newList.push(pair(market))
            pairsMap[key] = newList
        } else {
            pairsMap[key] = [
                pair(market)
            ]
        }
        pairsList.add(market.base_asset_symbol)
        pairsList.add(market.quote_asset_symbol)
    })

    const list = <string[]>Array.from(pairsList.values())
    return <TokenItem[]>list.map(item => {
        const token = tokensMap[item]
        return new TokenItem (
            assetIdSymbol(token.symbol, BNBSymbol, CoinType.binance),
            tokenType(token.symbol, BNBSymbol, TokenType.BEP2),
            token.symbol,
            token.name,
            token.original_symbol,
            decimals,
            logoURI(token.symbol, 'binance', BNBSymbol),
            pairsMap[token.symbol] || []
    )
    });
}
