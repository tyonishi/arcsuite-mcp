export const V1_SOAP_OPERATION_ALLOWLIST = new Set([
  "getVersionInfo",
  "getLoginInfo",
  "login",
  "logout",
  "getSessionInfo",
  "getAttributeSchema",
  "getAttributeSchemas",
  "getRepositoryObject",
  "getRepositoryObjects",
  "getRepositoryObjectByRevisionNumber",
  "getRepositoryObjectPath",
  "getRepositoryObjectPaths",
  "getRepositoryObjectContent",
  "getRepositoryObjectContentWithOptions",
  "listRepositoryObjects",
  "listRepositoryObjectIds",
  "listRepositoryObjectHardReferences",
  "searchRepositoryObjects",
  "searchRepositoryObjectIds",
  "listRepositoryObjectRevisions",
  "listRepositoryServices",
  "getCabinetInformation",
  "getCabinetInformations",
  "getRepositoryObjectClassDefinitions"
]);

export const FORBIDDEN_SOAP_OPERATIONS = new Set([
  "assertPrivilege",
  "enableAdministratorMode",
  "getRepositoryObjectContentForPrint",
  "changeRepositoryObjectAcl",
  "changeRepositoryObjectDefaultAcl",
  "deleteRepositoryObject",
  "deleteRepositoryObjects",
  "terminateProcess",
  "terminateProcesses",
  "executeDelegatedAction",
  "executeDelegatedActionByName",
  "putHardReference",
  "putHardReferenceWithClass",
  "putReference",
  "putReferenceWithClass",
  "attachTimestamp",
  "attachTimestampWithOptions",
  "calculateCertificateEvidence",
  "validateCertificate",
  "getCertificateEvidence"
]);

export function assertOperationAllowlistSafe(): void {
  for (const operation of FORBIDDEN_SOAP_OPERATIONS) {
    if (V1_SOAP_OPERATION_ALLOWLIST.has(operation)) {
      throw new Error(`Forbidden SOAP operation present in v1 allowlist: ${operation}`);
    }
  }
}
