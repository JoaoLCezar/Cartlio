"use client";

import { useEffect, useId, useRef, useState } from "react";

type CustomerOption = { id: string; name: string };
type QuickChoice = { value: string; label: string };

type CustomerPickerProps = {
  tenantId: string;
  name: string;
  inputId: string;
  initialValue?: string | null;
  initialName?: string | null;
  placeholder?: string;
  quickChoices?: QuickChoice[];
};

export function CustomerPicker({
  tenantId,
  name,
  inputId,
  initialValue = "",
  initialName,
  placeholder = "Digite nome, e-mail ou WhatsApp",
  quickChoices = [],
}: CustomerPickerProps) {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const initialQuickChoice = quickChoices.find(choice => choice.value === initialValue);
  const [selectedValue, setSelectedValue] = useState(initialValue ?? "");
  const [selectedName, setSelectedName] = useState(initialName ?? "");
  const [query, setQuery] = useState(initialName ?? (initialValue ? initialQuickChoice?.label : "") ?? "");
  const [results, setResults] = useState<CustomerOption[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");

  useEffect(() => {
    const term = query.trim();
    if (selectedValue || [...term].length < 2) return;

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setStatus("loading");
      try {
        const response = await fetch(`/painel/${tenantId}/clientes/buscar?q=${encodeURIComponent(term)}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!response.ok) throw new Error("Customer search failed");
        const data = await response.json() as { customers?: CustomerOption[] };
        setResults(data.customers ?? []);
        setStatus("idle");
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setResults([]);
        setStatus("error");
      }
    }, 250);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, selectedValue, tenantId]);

  function chooseQuickValue(choice: QuickChoice) {
    inputRef.current?.setCustomValidity("");
    setSelectedValue(choice.value);
    setSelectedName("");
    setQuery(choice.value ? choice.label : "");
    setResults([]);
    setStatus("idle");
  }

  function chooseCustomer(customer: CustomerOption) {
    inputRef.current?.setCustomValidity("");
    setSelectedValue(customer.id);
    setSelectedName(customer.name);
    setQuery(customer.name);
    setResults([]);
    setStatus("idle");
  }

  return <div className="space-y-2">
    <input type="hidden" name={name} value={selectedValue} />
    {quickChoices.length > 0 && <div className="flex flex-wrap gap-2" aria-label="Opções de vínculo">
      {quickChoices.map(choice => <button
        key={`${choice.value}:${choice.label}`}
        type="button"
        className={`rounded-full border px-3 py-1.5 text-xs transition ${selectedValue === choice.value && !selectedName ? "border-amber-300 text-amber-200" : "border-stone-700 text-stone-400 hover:border-stone-500 hover:text-stone-200"}`}
        aria-pressed={selectedValue === choice.value && !selectedName}
        onClick={() => chooseQuickValue(choice)}
      >{choice.label}</button>)}
    </div>}
    <div className="relative">
      <input
        ref={inputRef}
        id={inputId}
        type="search"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={results.length > 0}
        aria-controls={listId}
        aria-busy={status === "loading"}
        autoComplete="off"
        maxLength={120}
        placeholder={placeholder}
        value={query}
        onChange={event => {
          const value = event.currentTarget.value;
          setQuery(value);
          setSelectedValue("");
          setSelectedName("");
          setResults([]);
          setStatus([...value.trim()].length >= 2 ? "loading" : "idle");
          event.currentTarget.setCustomValidity(value.trim() ? "Escolha um cliente na lista ou limpe a busca." : "");
        }}
        onKeyDown={event => {
          if (event.key === "Enter" && results.length > 0) {
            event.preventDefault();
            chooseCustomer(results[0]);
          }
          if (event.key === "Escape") setResults([]);
        }}
      />
      {results.length > 0 && <ul id={listId} role="listbox" className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-stone-700 bg-stone-950 p-1 shadow-xl">
        {results.map(customer => <li key={customer.id} role="option" aria-selected={false}>
          <button type="button" className="w-full rounded-md px-3 py-2 text-left text-sm text-stone-200 hover:bg-stone-800 focus:bg-stone-800 focus:outline-none" onClick={() => chooseCustomer(customer)}>{customer.name}</button>
        </li>)}
      </ul>}
    </div>
    <p className="min-h-5 text-xs text-stone-500" aria-live="polite">
      {status === "loading" ? "Buscando clientes…" : status === "error" ? "Não foi possível buscar. Tente novamente." : results.length === 0 && query.trim().length >= 2 && !selectedValue ? "Nenhum cliente encontrado. Limpe a busca para remover o vínculo." : selectedName ? `Cliente selecionado: ${selectedName}` : "Digite ao menos 2 caracteres para buscar."}
    </p>
  </div>;
}
