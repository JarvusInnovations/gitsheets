<template lang="pug">
  article.LogCommit
    .flex
      img.LogCommit__avatar(:src="`https\://api.adorable.io/avatars/80/${author}`")
      .LogCommit__body
        a.LogCommit__author(:href="`/users/${author}`") @{{ author }}
        | &#32;
        //- space
        span.LogCommit__message {{ message }}

        .LogCommit__meta
          time.LogCommit__date(:datetime="date", :title="localeDate") {{ relativeDate }}
          .LogCommit__id(:title="id") {{ shortHash }}
</template>

<script>
import ago from 's-ago';

export default {
  name: 'LogCommit',

  props: {
    id: {
      type: String,
      required: true,
    },
    date: {
      type: Date,
      required: true,
    },
    author: {
      type: String,
      required: true,
    },
    message: {
      type: String,
      default: null,
    },
  },

  computed: {
    localeDate() {
      return this.date.toLocaleString();
    },

    relativeDate() {
      return ago(this.date);
    },

    shortHash() {
      return this.id.slice(0, 7);
    },
  },
}
</script>

<style lang="postcss">
.LogCommit {
  @apply border-t py-3 text-sm;

  &:first-child {
    @apply border-0 pt-2;
  }

  &__avatar {
    @apply h-10 w-10 mr-3 rounded;
  }

  &__meta {
    @apply flex justify-between text-gray-500;
  }
}
</style>
