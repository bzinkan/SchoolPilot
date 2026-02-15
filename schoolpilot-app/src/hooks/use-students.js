import { useQuery, useMutation } from '@tanstack/react-query';
import { apiRequest, queryClient } from '../lib/queryClient';

// --- Query hooks (use fetch for GETs to get the raw Response) ---

export function useStudents() {
  return useQuery({
    queryKey: ['students'],
    queryFn: async () => {
      const res = await fetch('/api/students', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch students');
      return res.json();
    },
    select: (data) => Array.isArray(data) ? data : (data?.students ?? []),
  });
}

export function useGrades() {
  return useQuery({
    queryKey: ['grades'],
    queryFn: async () => {
      const res = await fetch('/api/grades', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch grades');
      return res.json();
    },
    select: (data) => Array.isArray(data) ? data : (data?.grades ?? []),
  });
}

export function useTeachers() {
  return useQuery({
    queryKey: ['teachers'],
    queryFn: async () => {
      const res = await fetch('/api/admin/teachers', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch teachers');
      return res.json();
    },
    select: (data) => Array.isArray(data) ? data : (data?.teachers ?? data?.staff ?? []),
  });
}

// --- Mutation hooks (use apiRequest which wraps axios) ---

export function useCreateStudent() {
  return useMutation({
    mutationFn: (data) => apiRequest('POST', '/students', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['students'] });
    },
  });
}

export function useUpdateStudent() {
  return useMutation({
    mutationFn: ({ id, ...data }) => apiRequest('PATCH', `/students/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['students'] });
    },
  });
}

export function useDeleteStudent() {
  return useMutation({
    mutationFn: (id) => apiRequest('DELETE', `/students/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['students'] });
    },
  });
}

export function useCreateGrade() {
  return useMutation({
    mutationFn: (data) => apiRequest('POST', '/grades', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['grades'] });
    },
  });
}

export function useDeleteGrade() {
  return useMutation({
    mutationFn: (id) => apiRequest('DELETE', `/grades/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['grades'] });
    },
  });
}
