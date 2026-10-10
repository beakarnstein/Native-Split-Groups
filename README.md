# Native Split Groups

Al agrupar en una Base de Obsidian por una propiedad de lista, las notas que tengan múltiples opciones seleccionadas se mostrarán una vez debajo de cada opción, en lugar de crear un nuevo grupo con las opciones combinadas. Trabaja sobre las vistas nativas de Obsidian sin necesidad de crear vistas nuevas.
Por ejemplo, una nota con la propiedad de lista "Género" que tenga seleccionadas las opciones de "Comedia" y "Romance", se mostrará una vez debajo del grupo de "Comedia" y otra debajo de "Romance"; en vez de la opción nativa de Obsidian de crear un grupo llamado "Comedia Romance".

## Uso

1. Instalar el plugin y activarlo.
2. En cualquier Base, usa **Agrupar por** con una propiedad de lista.
3. Los grupos se dividirán solos según las opciones disponibles de la propiedad de lista.

Se incluye en los Ajustes del plugin una opción para controlar qué comportamiento tiene una nota al moverse entre columnas de la vista Kanban (la nativa de Obsidian). Las opciones son:
  1. *Sustituir todo por la columna nueva*: la lista queda solo con la opción correspondiente a la columna a la que se arrastró la nota.
  2. *Agregar la columna nueva a las anteriores*: la columna nueva se añade como opción al final de la propiedad, sin afectar las opciones elegidas previamente.
  3. *Reemplazar columna de origen por columna nueva*: se quita el valor de la columna de la que se arrastra, se pone el nuevo y el resto de las opciones queda intacto. Si no se puede saber el origen, actúa como la opción 2 y lanza un error (no borra el resto de las opciones).

## Instalación manual

Copia `main.js` y `manifest.json` a `<tu-vault>/.obsidian/plugins/native-split-groups/`, recarga Obsidian y actívalo en Configuración → Complementos de la comunidad.