// Computes the Levenshtein edit distance between two patterns.
// This is accomplished via a memory-optimized Wagner-Fischer algorithm
//
// This variant avoids allocation if you already have buffers.
#[inline]
pub fn edit_distance_min_alloc(
    source: &[char],
    target: &[char],
    previous_row: &mut Vec<u8>,
    current_row: &mut Vec<u8>,
) -> u8 {
    if cfg!(debug_assertions) {
        assert!(source.len() <= 255 && target.len() <= 255);
    }

    let row_width = source.len();
    let col_height = target.len();

    previous_row.clear();
    previous_row.extend(0u8..=row_width as u8);
    // Alright if not zeroed, since we overwrite it anyway.
    current_row.resize(row_width + 1, 0);

    for j in 1..=col_height {
        current_row[0] = j as u8;

        for i in 1..=row_width {
            let cost = if source[i - 1] == target[j - 1] { 0 } else { 1 };

            current_row[i] = (previous_row[i] + 1)
                .min(current_row[i - 1] + 1)
                .min(previous_row[i - 1] + cost);
        }

        std::mem::swap(previous_row, current_row);
    }

    previous_row[row_width]
}

pub fn edit_distance(source: &[char], target: &[char]) -> u8 {
    edit_distance_min_alloc(source, target, &mut Vec::new(), &mut Vec::new())
}

#[cfg(test)]
mod tests {
    use super::edit_distance;

    fn assert_edit_dist(source: &str, target: &str, expected: u8) {
        let source: Vec<_> = source.chars().collect();
        let target: Vec<_> = target.chars().collect();

        let dist = edit_distance(&source, &target);
        assert_eq!(dist, expected)
    }

    #[test]
    fn simple_edit_distance_1() {
        assert_edit_dist("kitten", "sitting", 3)
    }

    #[test]
    fn simple_edit_distance_2() {
        assert_edit_dist("saturday", "sunday", 3)
    }

    #[test]
    fn one_edit_distance() {
        let source: Vec<_> = "hello".chars().collect();
        let target: Vec<_> = "hellos".chars().collect();
        assert_eq!(edit_distance(&source, &target), 1);

        let target: Vec<_> = "hell".chars().collect();
        assert_eq!(edit_distance(&source, &target), 1);

        let target: Vec<_> = "hell".chars().collect();
        assert_eq!(edit_distance(&source, &target), 1);

        let target: Vec<_> = "hvllo".chars().collect();
        assert_eq!(edit_distance(&source, &target), 1);

        let target: Vec<_> = "Hello".chars().collect();
        assert_eq!(edit_distance(&source, &target), 1);
    }

    #[test]
    fn zero_edit_distance() {
        let source: Vec<_> = "hello".chars().collect();
        let target: Vec<_> = "hello".chars().collect();
        assert_eq!(edit_distance(&source, &target), 0);
    }
}
