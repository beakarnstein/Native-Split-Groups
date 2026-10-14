# Native Split Groups

When grouping a Base by a list property, notes with multiple selected options will appear once under each option, rather than creating a new group with the merged options. This works with native views without requiring the creation of new ones.
For example, a note with a "Genre" list property where both "Comedy" and "Romance" are selected, will appear once under the "Comedy" group and again under "Romance", instead of the default behavior of creating a group named "Comedy Romance".

## Usage

1. Install and activate the plugin.
2. In any Base, use **Group by** with a list property.
3. The groups will automatically split based on the available options for the list property.

### Kanban drag

##### General
When you drag a card to another column in a Kanban view, Obsidian replaces the whole list with the column you dropped it on. This plugin lets you choose what happens instead:

1. *Replace everything with the new column*: the list is left with only the option of the column the note was dropped on (Obsidian's default).
2. *Add the new column to the previous ones*: the new option is added at the end of the list, without affecting the options already selected.
3. *Replace the source column with the new column*: the value of the column the note was dragged from is removed, the new value is inserted, and the remaining options stay intact. If the source column cannot be determined, it behaves like option 2 and shows a notice.

##### Individual Kanban Views
You can choose this per Kanban view: open the view's settings and use **Split Groups: card drag**. Each view stores its choice in the `.base` file. *Plugin default* uses the value from the plugin settings, which is also the value used for new views and for Kanban views embedded in notes.

##### 'None' Group
Dropping a card on the 'None' column (no value):

- Option 1. The property is left empty, in its original position. If the note does not have the property, it stays without it.
- Option 2. Nothing changes.
- Option 3. Only the source option is removed; the other options stay. If it was the only one, the property is left empty.

##### Listing every option in the Group menu

With Group order → Manual, Obsidian only lists in the Group menu the groups of notes the view currently shows. 
With this plugin, in a Kanban view you can turn on **Split Groups: list all property options in the Group menu** so the menu also lists every option the property has anywhere in your vault, as hidden groups with 0 notes. 
Then, they can be made visible as empty columns even if the view's filters leave no note with that option. The **None** group (notes without a value) is also offered even if no visible note lacks the property. Options left hidden stay hidden.

## Installation

Copy `main.js` and `manifest.json` to 'native-split-groups' inside your plugins folder. Reload the program and enable the plugin under Settings → Community plugins.

## Reporting a problem

Turn on **Diagnostics** in the plugin settings, reproduce the problem (for example, reorder the groups), then run the command **Copy diagnostics** and paste the result into an issue. It contains the Obsidian version, the plugin settings, the text of the open `.base` files and a short log of the groups Obsidian handed to the plugin (key, type and number of notes per group; no note contents). Review it before sharing. Turn Diagnostics off afterwards.

## Languages

The plugin interface (settings, command and notices) is available in English and Spanish. It follows the language of Obsidian (Settings → General → Language): Spanish when the app is set to Spanish, English otherwise.
