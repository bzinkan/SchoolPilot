import { apiRequest } from "../../../lib/queryClient";
import { myDeskIdentityEpoch } from "./myDeskModel";

export function studentInformationApi(schoolId, signal) {
  if (!schoolId) throw new Error("Select a school.");
  const epoch = myDeskIdentityEpoch();
  const request = async (method, path, data, config = {}) => {
    const check = () => {
      signal?.throwIfAborted();
      if (epoch !== myDeskIdentityEpoch())
        throw new DOMException("School access changed.", "AbortError");
    };
    check();
    const result = await apiRequest(
      method,
      `/classpilot/student-information${path}`,
      data,
      {
        ...config,
        signal,
        headers: { "X-School-Id": schoolId, ...config.headers },
      },
    );
    check();
    return result;
  };
  return {
    get: (path) => request("GET", path),
    search: (filters) => request("POST", "/search", filters),
    profile: (id) => request("GET", `/students/${encodeURIComponent(id)}`),
    history: (id, cursor) =>
      request(
        "GET",
        `/students/${encodeURIComponent(id)}/history${cursor ? `?cursor=${cursor}` : ""}`,
      ),
    save: (id, data) =>
      request("PATCH", `/students/${encodeURIComponent(id)}`, data),
    createImport: (data) => request("POST", "/imports", data),
    import: (id) => request("GET", `/imports/${encodeURIComponent(id)}`),
    reserve: (id, data) =>
      request("POST", `/imports/${encodeURIComponent(id)}/assets`, data),
    upload: (id, assetId, file, type) =>
      request(
        "PUT",
        `/imports/${encodeURIComponent(id)}/assets/${encodeURIComponent(assetId)}/content`,
        file,
        { headers: { "Content-Type": type } },
      ),
    content: (id, assetId) =>
      request(
        "GET",
        `/imports/${encodeURIComponent(id)}/assets/${encodeURIComponent(assetId)}/content`,
        undefined,
        { responseType: "blob" },
      ),
    process: (id, data) =>
      request("POST", `/imports/${encodeURIComponent(id)}/process`, data),
    review: (id, itemId, data) =>
      request(
        "PATCH",
        `/imports/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}`,
        data,
      ),
    addItem: (id, data) =>
      request("POST", `/imports/${encodeURIComponent(id)}/items`, data),
    join: (id, itemId, data) =>
      request(
        "POST",
        `/imports/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}/join`,
        data,
      ),
    commit: (id, data) =>
      request("POST", `/imports/${encodeURIComponent(id)}/commit`, data),
    cancel: (id, data) =>
      request("DELETE", `/imports/${encodeURIComponent(id)}`, data),
  };
}
