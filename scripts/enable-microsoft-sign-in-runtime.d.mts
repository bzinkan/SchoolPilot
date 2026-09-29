export type TaskContainer = {
  name: string;
  environment?: Array<{ name: string; value: string }>;
  secrets?: Array<{ name: string; valueFrom: string }>;
};

export type TaskDefinition = { containerDefinitions?: TaskContainer[] } & Record<string, unknown>;

export type MicrosoftSignInRequest = { containerName: string; clientId: string; secretArn: string };

export const MICROSOFT_CLIENT_ID_NAME: "MICROSOFT_CLIENT_ID";
export const MICROSOFT_CLIENT_SECRET_NAME: "MICROSOFT_CLIENT_SECRET";

export function validateClientId(clientId: unknown): string;
export function microsoftClientSecretArn(context: {
  region: string;
  accountId: string;
  project: string;
  environment: string;
}): string;
export function addMicrosoftSignIn<T extends TaskDefinition>(taskDefinition: T, request: MicrosoftSignInRequest): T;
export function assertMicrosoftSignIn(taskDefinition: TaskDefinition, request: MicrosoftSignInRequest): void;
