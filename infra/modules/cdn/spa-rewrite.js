// CloudFront Function (viewer-request) for the DEFAULT (S3) behavior only.
// Rewrites extensionless URIs (SPA routes like /gopilot/dashboard) to
// /index.html so deep links load the app shell, while real files
// (/assets/x.js, /favicon.ico) pass through untouched.
//
// This replaces the old distribution-wide CustomErrorResponses 403/404 → 200
// rewrite, which also masked every /api/* error as 200 + HTML.
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  var lastSegment = uri.split('/').pop();
  if (lastSegment.includes('.')) {
    return request;
  }
  request.uri = '/index.html';
  return request;
}
