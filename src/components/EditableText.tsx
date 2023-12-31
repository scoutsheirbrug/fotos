import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import { Icons } from './Icons'

type Props = {
	value: string
	onChange: (value: string) => void
	editable?: boolean,
	nopencil?: boolean,
	autofocus?: boolean,
	class?: string,
}
export function EditableText({ value, onChange, editable, nopencil, autofocus, class: clazz }: Props) {
	const [newValue, setNewValue] = useState<string>()
	const inputRef = useRef<HTMLInputElement>(null)

	const startEditing = useCallback(() => {
		setNewValue(value)
		setTimeout(() => {
			inputRef.current?.select()
		})
	}, [value])

	useEffect(() => {
		if (autofocus) startEditing()
	}, [])

	const onEnter = useCallback((e: KeyboardEvent | FocusEvent) => {
		if (e instanceof FocusEvent || e.key === 'Enter') {
			if (newValue !== undefined && newValue.length > 0) {
				onChange(newValue)
			}
			setNewValue(undefined)
		}
	}, [newValue, onChange])

	return <div class={`group w-full ${editable ? 'cursor-pointer' : ''}`} onClick={newValue !== undefined || !editable ? undefined : startEditing}>
		{newValue === undefined
			? <>
				<div class={`border-b border-transparent ${clazz}`}>
					{value}&nbsp;
					{editable && !nopencil && <span class="hidden group-hover:inline [&>*]:inline [&>*]:mb-1">{Icons.pencil}</span>}
				</div>
			</>
			: <input ref={inputRef} class={`outline-none border-b border-gray-300 bg-gray-50 ${clazz}`} type="text" value={newValue} onInput={(e) => setNewValue((e.target as HTMLInputElement).value)} onKeyDown={onEnter} onBlur={onEnter} />}
	</div>
}
