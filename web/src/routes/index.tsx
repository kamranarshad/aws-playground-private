import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  component: App,
})

function App() {
  return <div className="p-8 text-xl font-semibold">Lambda Playground</div>
}
