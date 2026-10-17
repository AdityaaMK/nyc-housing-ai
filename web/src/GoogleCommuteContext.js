import { createContext, useContext } from 'react';
export const GoogleCommuteContext = createContext(null);
export const useGoogleCommuteResults = () => useContext(GoogleCommuteContext)?.results || {};
