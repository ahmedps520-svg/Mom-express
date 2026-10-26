export function CardSkeleton() {
  return (
    <div className="card card-pad" aria-hidden="true">
      <div className="row gap-12">
        <div className="skeleton" style={{ width: 46, height: 46, borderRadius: 15 }} />
        <div className="grow stack gap-8">
          <div className="skeleton" style={{ width: '60%', height: 16 }} />
          <div className="skeleton" style={{ width: '40%', height: 12 }} />
        </div>
      </div>
      <div className="skeleton" style={{ width: '100%', height: 6, marginTop: 16 }} />
    </div>
  );
}

export function RowSkeleton() {
  return (
    <div className="list-row" aria-hidden="true">
      <div className="skeleton" style={{ width: 38, height: 38, borderRadius: 12 }} />
      <div className="grow stack gap-8">
        <div className="skeleton" style={{ width: '50%', height: 14 }} />
        <div className="skeleton" style={{ width: '30%', height: 11 }} />
      </div>
    </div>
  );
}
