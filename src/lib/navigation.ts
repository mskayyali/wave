import { createContext, useContext } from 'react';

// Moving between Wave's screens from deep inside one (the editor's tool panels
// sending you to Settings to download a model). App provides it.

export interface Navigation {
  openSettings: () => void;
}

export const NavigationContext = createContext<Navigation>({ openSettings: () => undefined });

export const useNavigation = () => useContext(NavigationContext);
