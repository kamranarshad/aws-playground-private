import { Trash2 } from 'lucide-react'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SettingsSheet } from '@/components/settings-sheet'
import { useDeleteFunction } from '@/lib/queries'
import type { FunctionDef } from '@/lib/types'

export function FunctionHeader({ fn, onDeleted }: { fn: FunctionDef; onDeleted: () => void }) {
  const del = useDeleteFunction()
  return (
    <div className="flex items-center gap-2 border-b px-4 py-2">
      <h2 className="truncate text-sm font-semibold">{fn.name}</h2>
      <Badge variant="secondary" className="font-mono">{fn.runtime}</Badge>
      <span className="truncate font-mono text-xs tabular-nums text-muted-foreground">
        {fn.handler || 'no handler set'} · {fn.timeoutMs}ms · {fn.memoryMb}MB
      </span>
      <div className="ml-auto flex items-center gap-1">
        <SettingsSheet fn={fn} />
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Delete function">
              <Trash2 className="size-4 text-destructive" />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {fn.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                Removes the registration and its invoke history. The project folder is untouched.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={del.isPending}
                onClick={(e) => {
                  // Keep the dialog open so the pending state stays visible;
                  // the header unmounts on success once the function is gone.
                  e.preventDefault()
                  del.mutate(fn.id, { onSuccess: onDeleted })
                }}
              >
                {del.isPending ? 'Deleting…' : 'Delete'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  )
}
