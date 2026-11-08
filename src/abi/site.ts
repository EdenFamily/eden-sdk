import { parseAbi } from "viem";

/**
 * The short human-readable ABIs the website uses (eden-web/src/lib/chain.ts), same names. The full ABIs are in
 * ./eden.ts (edenBondingCurveAbi, edenLaunchFactoryAbi, ...); verification decodes with those.
 */
export const curveAbi = parseAbi([
  "function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)",
  "function feeBps() view returns (uint256)",
  "function creatorTaxBps() view returns (uint256)",
  "function graduated() view returns (bool)",
  "function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256)",
  "function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256)",
]);
export const escrowAbi = parseAbi(["function claim() returns (uint256)", "function balanceOf(address) view returns (uint256)"]);

const tokenParams = "(string name, string symbol, string logo, string description, (string twitter, string telegram, string discord, string website, string farcaster) socials, address creatorFeeRecipient, uint16 creatorTaxBps, bool buybackEnabled, bytes32 expectedEconomics, bytes32 salt)";
export const factoryAbi = parseAbi([
  `function launchToken(${tokenParams} params, uint256 launchConfigId, address pairToken, address[] snipeTaxExemptions) payable returns (address token, address curve)`,
  "event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)",
]);
export const launchAndBuyAbi = parseAbi([
  `function launchAndBuy(${tokenParams} params, uint256 launchConfigId, address pairToken, uint256 quoteIn, uint256 minTokensOut, address recipient, address[] snipeTaxExemptions) payable returns (address token, address curve, uint256 tokensOut)`,
]);

/** Appended to the calldata of every transaction the site builds (website name for EDEN_CALLDATA_MARKER). */
export const EDEN_MARKER = "4544454e0001";
/** Launch fee on mainnet (0.0005 HYPE); read factory.launchFee() for the live value. */
export const LAUNCH_FEE_WEI = 500_000_000_000_000n;
