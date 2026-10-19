import { useQuery } from '@tanstack/react-query'
import { api, ApiError } from './api'

export const meQueryKey = ['auth', 'me'] as const

/** Utilisateur connecté, ou `null` si la session est absente ou expirée. */
export function useCurrentUser() {
  return useQuery({
    queryKey: meQueryKey,
    queryFn: async () => {
      try {
        return await api.me()
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null
        throw error
      }
    },
    staleTime: 60_000,
  })
}
