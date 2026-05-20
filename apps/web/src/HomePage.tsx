export function HomePage() {
  return (
    <div className="home">
      <h1>comment-md</h1>
      <p>
        Open a note at <code>/notes/&lt;noteId&gt;</code>. Create notes via the
        CLI:
      </p>
      <pre>
        <code>{`comment-md create ./your-file.md`}</code>
      </pre>
      <p>
        Configure the CLI with <code>COMMENT_MD_SERVER_URL=http://127.0.0.1:3210</code>.
      </p>
    </div>
  );
}
