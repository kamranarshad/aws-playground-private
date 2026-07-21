import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

type Theme = 'light' | 'dark'
const ThemeContext = createContext<{ theme: Theme; toggle: () => void }>({
  theme: 'dark',
  toggle: () => {},
})

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Dark is the fallback when no preference is stored; the pre-paint script in
  // __root applies the same default to the DOM, and the effect below adopts
  // whatever it resolved so the provider and the document never disagree.
  const [theme, setTheme] = useState<Theme>('dark')

  useEffect(() => {
    // The pre-paint script in __root already resolved and applied the theme
    // class. Adopt it so the provider and the DOM never disagree.
    setTheme(document.documentElement.classList.contains('dark') ? 'dark' : 'light')
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
  }, [theme])

  const toggle = () => {
    setTheme((t) => {
      const next = t === 'dark' ? 'light' : 'dark'
      localStorage.setItem('awsplay-theme', next)
      return next
    })
  }

  return <ThemeContext.Provider value={{ theme, toggle }}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  return useContext(ThemeContext)
}
