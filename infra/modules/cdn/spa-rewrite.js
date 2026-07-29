// CloudFront Function (viewer-request) for the DEFAULT (S3) behavior only.
// Redirects alternate hosts and visible index/trailing-slash URLs to one
// canonical URL, then rewrites extensionless SPA routes to /index.html.
//
// This replaces the old distribution-wide CustomErrorResponses 403/404 → 200
// rewrite, which also masked every /api/* error as 200 + HTML.
function buildQueryString(querystring) {
  var parts = [];
  var names = Object.keys(querystring || {}).sort();

  for (var i = 0; i < names.length; i += 1) {
    var name = names[i];
    var parameter = querystring[name];
    var values = parameter.multiValue || [parameter];

    for (var j = 0; j < values.length; j += 1) {
      parts.push(
        encodeURIComponent(name) +
          '=' +
          encodeURIComponent(values[j].value || '')
      );
    }
  }

  return parts.length > 0 ? '?' + parts.join('&') : '';
}

function redirect(location) {
  return {
    statusCode: 301,
    statusDescription: 'Moved Permanently',
    headers: {
      location: { value: location },
      'cache-control': { value: 'public, max-age=3600' },
    },
  };
}

function handler(event) {
  var request = event.request;
  var uri = request.uri || '/';
  var canonicalHost = '__CANONICAL_HOST__';
  var hostHeader = request.headers.host;
  var host = hostHeader ? hostHeader.value.toLowerCase() : '';
  var canonicalUri = uri;

  if (canonicalUri === '/index.html') {
    canonicalUri = '/';
  } else if (
    canonicalUri.length > 1 &&
    canonicalUri.charAt(canonicalUri.length - 1) === '/'
  ) {
    canonicalUri = canonicalUri.slice(0, -1);
  }

  if (
    canonicalUri !== uri ||
    (canonicalHost && host && host !== canonicalHost)
  ) {
    var origin = canonicalHost ? 'https://' + canonicalHost : '';
    return redirect(
      origin + canonicalUri + buildQueryString(request.querystring)
    );
  }

  var lastSegment = uri.split('/').pop();
  if (lastSegment.includes('.')) {
    return request;
  }
  request.uri = '/index.html';
  return request;
}
