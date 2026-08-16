import {
  decodeJwtPayload,
  extractWalletAddress,
  OpenSeaOAuth,
  type DeviceAuthorizationResponse,
  type OAuthToken,
} from "@opensea/sdk";
import { isAddress } from "viem";
import type { AppEnv } from "../config/env.js";
import {
  findEligibleAllowlistStages,
  type EligibilityScanResult,
} from "../opensea/eligibility.js";
import { logger } from "../config/logger.js";
import { UserFacingError } from "../utils/errors.js";
import { normalizeAddress } from "../utils/address.js";

export interface EligibilityCheckResult extends EligibilityScanResult {
  requestedAddress: string;
  authenticatedAddress: string;
}

export interface EligibilitySession {
  device: DeviceAuthorizationResponse;
  result: Promise<EligibilityCheckResult>;
}

/**
 * Runs OpenSea's OAuth device flow without persisting wallet credentials. Only
 * one short-lived check is allowed per Telegram user at a time.
 */
export class EligibilityService {
  private readonly pending = new Map<number, Promise<EligibilityCheckResult>>();

  constructor(private readonly env: AppEnv) {}

  async start(telegramId: number, requestedAddress: string): Promise<EligibilitySession> {
    if (this.pending.has(telegramId)) {
      throw new UserFacingError(
        "You already have an eligibility check waiting for OpenSea sign-in. Finish that one or wait for it to expire.",
        "eligibility_in_progress",
      );
    }
    const normalizedRequested = normalizeAddress(requestedAddress);
    const oauth = new OpenSeaOAuth({
      clientId: this.env.OPENSEA_OAUTH_CLIENT_ID,
      issuer: "https://auth.opensea.io",
    });
    const device = await oauth.requestDeviceAuthorization({ scopes: ["read:eligibility"] });
    const result = this.finish(oauth, device, normalizedRequested);
    this.pending.set(telegramId, result);
    void result.catch(() => undefined).finally(() => {
      if (this.pending.get(telegramId) === result) this.pending.delete(telegramId);
    });
    return { device, result };
  }

  cancel(telegramId: number): boolean {
    return this.pending.delete(telegramId);
  }

  private async finish(
    oauth: OpenSeaOAuth,
    device: DeviceAuthorizationResponse,
    requestedAddress: string,
  ): Promise<EligibilityCheckResult> {
    let token: OAuthToken | undefined;
    try {
      token = await oauth.pollDeviceToken(device);
      const claims = decodeJwtPayload(token.accessToken);
      const authenticatedWallet = extractWalletAddress(claims);
      if (!authenticatedWallet || !isAddress(authenticatedWallet, { strict: false })) {
        throw new UserFacingError(
          "OpenSea did not provide a verifiable wallet address for that sign-in.",
          "eligibility_wallet_missing",
        );
      }
      const authenticatedAddress = normalizeAddress(authenticatedWallet);
      if (authenticatedAddress !== requestedAddress) {
        throw new UserFacingError(
          `The OpenSea wallet you signed in with (${authenticatedAddress}) does not match the address you submitted (${requestedAddress}). No eligibility data was requested.`,
          "eligibility_wallet_mismatch",
        );
      }
      const scan = await findEligibleAllowlistStages(
        this.env.OPENSEA_API_KEY,
        token.accessToken,
      );
      return {
        ...scan,
        requestedAddress,
        authenticatedAddress,
      };
    } finally {
      if (token) {
        await oauth.revoke(token.refreshToken).catch((error) => {
          logger.warn({ err: error }, "OpenSea eligibility token revocation failed");
        });
      }
    }
  }
}
