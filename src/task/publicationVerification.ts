import type {
  PublicationExternalKind,
  PublicationProvider,
  PublicationState
} from "./publicationReference.js";

export type PublicationVerificationInput = Readonly<{
  provider: PublicationProvider;
  repository: string;
  externalKind: PublicationExternalKind;
  externalId: string;
  externalUrl?: string;
  expectedLocalCommit: string;
}>;

export type PublicationVerificationObservation = Readonly<{
  provider: PublicationProvider;
  repository: string;
  externalKind: PublicationExternalKind;
  externalId: string;
  externalUrl?: string;
  state: PublicationState;
  headCommit: string;
  remoteCommit?: string;
  mergedAt?: string;
  evidence: string;
}>;

/**
 * Provider-neutral external fact reader. It never mutates Task state or
 * Publication evidence; the command layer validates and persists a returned
 * observation against current Task authority.
 */
export type PublicationVerifier = Readonly<{
  inspect(
    input: PublicationVerificationInput
  ): Promise<PublicationVerificationObservation>;
}>;
