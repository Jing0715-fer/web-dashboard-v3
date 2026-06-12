# Task 3-a: Toast Notifications + Remote EnvVars Editing

## Summary
Added missing toast notifications for error cases and implemented inline environment variable editing in the DetailSheet component.

## Changes Made

### File: `/home/z/my-project/src/app/page.tsx`

#### Part 1: Toast Notifications (6 handlers fixed)
- `handleEnvAction` (~line 2864): Added `else` branch with error toast for `!res.ok` case
- `handleProjectSubmit` (edit mode, ~line 2725): Added `else` branch with error toast and parsed error description
- `handleDeleteProject` (~line 2743): Added `else` branch with error toast
- `handleEnvSubmit` (add mode, ~line 2953): Added `else` branch with error toast and parsed error description
- `handleEnvSubmit` (edit mode, ~line 2966): Added `else` branch with error toast and parsed error description
- `handleDeleteEnv` (~line 2987): Added `else` branch with error toast

#### Part 2: Remote EnvVars Editing
- Added 5 new state variables to DetailSheet component (~line 1521-1525):
  - `editingEnvVars` - tracks which env.id is being edited
  - `envVarDraft` - draft key-value pairs being edited
  - `newEnvKey` / `newEnvValue` - inputs for adding new pair
  - `savingEnvVars` - loading state for save operation

- Added 6 new functions to DetailSheet (~line 1590-1652):
  - `startEditingEnvVars()` - initiates editing, parses current vars
  - `saveEnvVars()` - PUTs updated vars via API, shows toast feedback
  - `addEnvVarPair()` - adds new key-value pair
  - `removeEnvVarPair()` - removes a pair
  - `updateEnvVarKey()` - updates key name
  - `updateEnvVarValue()` - updates value

- Added `onRefresh` optional prop to DetailSheet (~line 1511)
- Replaced static env vars display with conditional edit/view UI (~line 1922-2036)
  - "Edit" button with Edit3 icon in view mode
  - Inline editable form with Input fields in edit mode
  - Add new pair row with Plus button
  - Save/Cancel buttons with loading spinner
  - Delete button (Trash2 icon) for each pair
- Passed `onRefresh` prop to DetailSheet from Dashboard (~line 4059-4067)

## Key Design Decisions
1. Env vars sent as `Record<string, string>` object (not pre-stringified) to match existing EnvFormDialog pattern
2. Backend auto-proxies for remote projects, so same API endpoint works for both local and remote
3. Used `onRefresh` callback instead of local project state refresh to keep data flow consistent
4. Conditional rendering: view mode vs edit mode, no separate dialog needed

## Verification
- 0 lint errors
- Dev server compiles and runs
- No console errors
