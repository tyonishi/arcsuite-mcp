export const ARCSUITE_BASE_NS = "http://www.fujifilm.com/fb/2021/04/arcsuite/ws";
export const ARCSUITE_TYPES_NS = "http://www.fujifilm.com/fb/2021/04/arcsuite/ws/types";
export const ARCSUITE_ENDPOINT_PATH = "/ArcSuite/2021/04/ws";
export const ARCSUITE_WSDL_PATH = "/ArcSuite/2021/04/ws?wsdl";
export const ARCSUITE_REQUEST_VERSION = "4.0.0.0";
export const ARCSUITE_ATTACHMENT_TYPE = "mtom";
export const ARCSUITE_DEFAULT_LOCALE = "ja";
// ArcSuite's licensed WSDL declares revisionNumber as xsd:int.  The public
// semantic contract is deliberately narrower: revisions are positive and are
// validated before any adapter request is constructed.
export const MIN_REVISION_NUMBER = 1;
export const MAX_REVISION_NUMBER = 2_147_483_647;
export const MAX_PAGE_NUMBER = 1_000_000;
// ArcSuite repository object classes are qualified by the physical `rep`
// namespace.  Keep this identity inside the adapter contract; MCP callers
// never provide or receive the native class descriptor.
export const ARCSUITE_OBJECT_CLASS_NS = "rep";
// These are the standard repository object-class pairs used by the semantic
// gateway.  The native I18nString name is intentionally not exposed as the
// public `object_class` value.
export const ARCSUITE_SEMANTIC_OBJECT_CLASSES: Readonly<Record<string, string>> = Object.freeze({
  "rep:system:cabinet": "cabinet",
  "rep:system:drawer": "drawer",
  "rep:system:folder": "folder",
  "rep:system:document": "document",
  "rep:system:externalDocument": "externalDocument",
  "rep:system:dynamicExternalDocument": "dynamicExternalDocument",
  "rep:system:reference": "reference",
  "rep:system:hardReference": "hardReference",
  "rep:system:hardreference": "hardReference"
});
export const CONTENT_LABEL_PRIMARY = { ns: "rep", name: "system:primary" } as const;

export const DEFAULT_ATTRS = {
  name: { ns: "rep", name: "system:name" },
  objectType: { ns: "rep", name: "system:objecttype" },
  status: { ns: "rep", name: "system:status" },
  modifiedOn: { ns: "rep", name: "system:modifiedon" },
  modifiedBy: { ns: "rep", name: "system:modifiedby" },
  revisionNumber: { ns: "rep", name: "system:revisionnumber" },
  currentRevisionNumber: { ns: "rep", name: "system:currentrevisionnumber" },
  contentLabelList: { ns: "rep", name: "system:contentlabellist" }
} as const;
