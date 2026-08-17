import {
  decodeJwtPayload,
  extractWalletAddress,
  OpenSeaOAuth,
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

const AUTHORIZATION_WINDOW_MS = 10 * 60 * 1_000;

export interface EligibilityCheckResult extends EligibilityScanResult {
  requestedAddress: string;
  authenticatedAddress: string;
}

export interface EligibilitySession {
  authorizationUrl: string;
  expiresAt: Date;
  result: Promise<EligibilityCheckResult>;
}

export interface EligibilityCallbackResult {
  accepted: boolean;
  statusCode: number;
  message: string;
}

interface PendingEligibility {
  telegramId: number;
  requestedAddress: string;
  oauth: OpenSeaOAuth;
  codeVerifier: string;
  redirectUri: string;
  resolve: (result: EligibilityCheckResult) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Runs OpenSea's browser-based authorization-code + PKCE flow without
 * persisting wallet credentials. The short-lived authorization state and
 * tokens remain in memory only, and every authorization is single-use.
 */
export class EligibilityService {
  private readonly pendingByState = new Map<string, PendingEligibility>();
  private readonly pendingStateByTelegram = new Map<number, string>();

  constructor(private readonly env: AppEnv) {}

  async start(telegramId: number, requestedAddress: string): Promise<EligibilitySession> {
    if (this.pendingStateByTelegram.has(telegramId)) {
      throw new UserFacingError(
        "You already have an eligibility check waiting for OpenSea sign-in. Finish that one or wait for it to expire.",
        "eligibility_in_progress",
      );
    }
    const redirectUri = this.getRedirectUri();
    const normalizedRequested = normalizeAddress(requestedAddress);
    const oauth = new OpenSeaOAuth({
      clientId: this.env.OPENSEA_OAUTH_CLIENT_ID,
      issuer: "https://auth.opensea.io",
    });
    const authorization = await oauth.createAuthorizationRequest({
      redirectUri,
      scopes: ["read:eligibility"],
    });
    const expiresAt = new Date(Date.now() + AUTHORIZATION_WINDOW_MS);
    let resolveResult!: (result: EligibilityCheckResult) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<EligibilityCheckResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const timer = setTimeout(() => {
      const pending = this.pendingByState.get(authorization.state);
      if (!pending) return;
      this.removePending(authorization.state);
      pending.reject(new UserFacingError(
        "The OpenSea authorization link expired. Start the eligibility check again.",
        "eligibility_authorization_expired",
      ));
    }, AUTHORIZATION_WINDOW_MS);
    timer.unref?.();
    const pending: PendingEligibility = {
      telegramId,
      requestedAddress: normalizedRequested,
      oauth,
      codeVerifier: authorization.codeVerifier,
      redirectUri,
      resolve: resolveResult,
      reject: rejectResult,
      timer,
    };
    this.pendingByState.set(authorization.state, pending);
    this.pendingStateByTelegram.set(telegramId, authorization.state);
    return { authorizationUrl: authorization.url, expiresAt, result };
  }

  /**
   * Accepts one OAuth callback and starts the eligibility scan in the
   * background. The browser can return immediately while Telegram receives
   * the result through the pending promise from `start`.
   */
  handleCallback(url: URL): EligibilityCallbackResult {
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    const oauthError = url.searchParams.get("error");
    if (!state) {
      return { accepted: false, statusCode: 400, message: "Missing OAuth state. Return to Telegram and start again." };
    }
    const pending = this.pendingByState.get(state);
    if (!pending) {
      return { accepted: false, statusCode: 400, message: "This authorization link is expired or was already used. Return to Telegram and start again." };
    }
    this.removePending(state);
    if (oauthError) {
      pending.reject(new UserFacingError(
        "OpenSea sign-in was cancelled or denied. Start the eligibility check again if you want to retry.",
        "eligibility_authorization_denied",
      ));
      return { accepted: true, statusCode: 200, message: "OpenSea sign-in was not completed. You can return to Telegram." };
    }
    if (!code) {
      pending.reject(new UserFacingError(
        "OpenSea did not return an authorization code. Start the eligibility check again.",
        "eligibility_authorization_code_missing",
      ));
      return { accepted: false, statusCode: 400, message: "OpenSea did not return an authorization code. Return to Telegram and start again." };
    }
    void this.finish(pending, code)
      .then(pending.resolve)
      .catch(pending.reject);
    return { accepted: true, statusCode: 200, message: "Verification received. Return to Telegram for your eligibility result." };
  }

  private getRedirectUri(): string {
    const redirectUri = this.env.OPENSEA_OAUTH_REDIRECT_URI?.trim();
    if (!redirectUri) {
      throw new UserFacingError(
        "Eligibility is not configured yet. Set OPENSEA_OAUTH_REDIRECT_URI to your public HTTPS Railway callback URL.",
        "eligibility_redirect_not_configured",
      );
    }
    const parsed = new URL(redirectUri);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new UserFacingError(
        "OPENSEA_OAUTH_REDIRECT_URI must be a plain callback URL without credentials, query parameters, or fragments.",
        "eligibility_redirect_invalid",
      );
    }
    return parsed.toString();
  }

  private removePending(state: string): PendingEligibility | undefined {
    const pending = this.pendingByState.get(state);
    if (!pending) return undefined;
    clearTimeout(pending.timer);
    this.pendingByState.delete(state);
    if (this.pendingStateByTelegram.get(pending.telegramId) === state) {
      this.pendingStateByTelegram.delete(pending.telegramId);
    }
    return pending;
  }

  private async finish(pending: PendingEligibility, code: string): Promise<EligibilityCheckResult> {
    let token: OAuthToken | undefined;
    try {
      token = await pending.oauth.exchangeCode({
        code,
        codeVerifier: pending.codeVerifier,
        redirectUri: pending.redirectUri,
      });
      const claims = decodeJwtPayload(token.accessToken);
      const authenticatedWallet = extractWalletAddress(claims);
      if (!authenticatedWallet || !isAddress(authenticatedWallet, { strict: false })) {
        throw new UserFacingError(
          "OpenSea did not provide a verifiable wallet address for that sign-in.",
          "eligibility_wallet_missing",
        );
      }
      const authenticatedAddress = normalizeAddress(authenticatedWallet);
      if (authenticatedAddress !== pending.requestedAddress) {
        throw new UserFacingError(
          `The OpenSea wallet you signed in with (${authenticatedAddress}) does not match the address you submitted (${pending.requestedAddress}). No eligibility data was requested.`,
          "eligibility_wallet_mismatch",
        );
      }
      const scan: EligibilityScanResult = await findEligibleAllowlistStages(
        this.env.OPENSEA_API_KEY,
        token.accessToken,
      );
      return {
        ...scan,
        requestedAddress: pending.requestedAddress,
        authenticatedAddress,
      };
    } finally {
      if (token) {
        await pending.oauth.revoke(token.refreshToken).catch((error) => {
          logger.warn({ err: error }, "OpenSea eligibility token revocation failed");
        });
      }
    }
  }
}
