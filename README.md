# CI Mapping Toolkit

Tools for the SAP Cloud Integration message mapping editor. Open a message mapping in Edit mode,
select a target field and press **Space** (or **Ctrl+Space**) – or click **Mapping Toolkit** next to
*Simulate*. Type to search and press **Enter**.

Plain Space only opens the box when you are not typing: in a text field (e.g. a constant's value, the
search box) or on a focused button it keeps its normal meaning. Ctrl+Space always works.

If the mapping is read-only, the box offers **Switch the integration flow to Edit mode**: it presses
Edit on the surrounding integration flow (answer CPI's own questions, e.g. about an older lock) and
opens the same mapping again in Edit mode – no reload, you stay on the mapping.

## Functions
- The function is added to the Mapping Expression, at the mouse position if the mouse is over the canvas.
- If the selected target field has no mapping yet, a mapping is created and the function is connected
  to the field straight away.
- Choosing **constant** asks for the value first: Space → `const` → Enter → type `ABC` → Enter
  gives `Constant "ABC" → field`.
- Matches by prefix, substring, camelCase initials (e.g. `fbe` -> formatByExample) and description.
- Functions already used in the open mapping are listed first with a usage count, then recently used
  functions, then all functions A–Z (standard functions, UDFs and imported function libraries).

## Templates
- **Save:** select a mapped field and choose *Save mapping of … as template…* – everything that leads
  up to the field is saved. To save only part of it, open the **•••** menu of a function on the canvas
  and choose **Save as template…** (or click the function first and then open the box): that function
  and everything that feeds it is saved. Choose:
  - **Local** – offered only in this mapping.
  - **Global** – offered in every message mapping, on every tenant.
- **Insert:** templates are listed under *Templates*. By default a template is **added to the mapping
  without being connected**, below what is already there, so you can combine several templates and wire
  them up yourself. You can also choose to connect it to the selected field (replacing its mapping).
  In the mapping it was saved from you choose with or without the source mappings; in other mappings it
  is always inserted without them.
- **Delete:** select a template in the list and press **Del**.

## Format
- **Format mapping of <field>**, the **•••** menu entry **Format mapping** on any box, or
  **Ctrl+Shift+F** arranges the steps in order: source fields and constants on the left, each function
  one column left of what it feeds, the target field on the right, inputs in pin order from top to bottom,
  with about one box of space between columns.
- **Format all mappings in <mapping>** does the same for every field.

## Export / import
- **Export mappings of <mapping>…** downloads all field mappings as `<mapping>.mappings.json`.
- **Import mappings from a file…** loads such a file into the open mapping. Fields are matched by their
  path in the target structure; choose to overwrite fields that are already mapped (first option) or to
  import only into fields that are not mapped yet.
  Fields that do not exist in this target structure are skipped, and the result tells you how many
  mappings use source fields that are missing here.

Templates are stored in the extension (chrome.storage.local) on this computer. Changes only become
permanent when you click OK and Save in CPI; Cancel discards them.

## Install
1. Unzip the folder.
2. Open `chrome://extensions`, turn on **Developer mode**.
3. Click **Load unpacked** and select the folder.
4. Reload the Integration Suite tab.
