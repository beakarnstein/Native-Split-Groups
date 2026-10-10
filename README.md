# Native Split Groups

When grouping a Base by a list property, notes with multiple selected options will appear once under each option, rather than creating a new group with the merged options. This works with native views without requiring the creation of new ones.
For example, a note with a "Genre" list property where both "Comedy" and "Romance" are selected, will appear once under the "Comedy" group and again under "Romance", instead of the default behavior of creating a group named "Comedy Romance".

## Usage

1. Install and activate the plugin.
2. In any Base, use **Group by** with a list property.
3. The groups will automatically split based on the available options for the list property.

The plugin settings include an option to control how a note behaves when dragged between columns in the Kanban view (native view). The options are:
  1. *Replace everything with the new column*: the list is left with only the option corresponding to the column to which the note was dragged.
  2. *Add the new column to the previous ones*: the new column is added as an option at the end of the property, without affecting the previously selected options.
  3. *Replace the source column with the new column*: the value of the column from which the note is being dragged is removed, the new value is inserted, and the remaining options remain intact. If the source column cannot be determined, it behaves like option 2 and shows a notice (without deleting the remaining options).

## Installation

Copy `main.js` and `manifest.json` to 'native-split-groups' inside your plugins folder. Reload the program and enable the plugin under Settings → Community plugins.

## Languages

The plugin interface (settings, command and notices) is available in English and Spanish. It follows the language of Obsidian (Settings → General → Language): Spanish when the app is set to Spanish, English otherwise.
