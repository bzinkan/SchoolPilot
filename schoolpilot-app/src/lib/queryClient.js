import { QueryClient } from '@tanstack/react-query';
import api from '../shared/utils/api';

async function apiRequest(method, url, data) {
  const res = await api({ method, url, data });
  return res.data;
}

export { apiRequest };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 0,
      retry: 1,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      gcTime: 1000 * 60 * 5,
    },
  },
});
